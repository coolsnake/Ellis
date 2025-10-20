// @ts-nocheck
import {
	DriftClient,
	PerpMarketAccount,
	SpotMarketAccount,
	SlotSubscriber,
	UserMap,
	MarketType,
	DLOBSubscriber,
	PublicKey,
	BlockhashSubscriber,
	PriorityFeeSubscriber,
	isVariant,
	getTriggerPrice,
	BN,
	useMedianTriggerPrice,
} from '@drift-labs/sdk';
import { logger } from '../utils/logger';
import {
	AddressLookupTableAccount,
	ComputeBudgetProgram,
	TransactionInstruction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';

const TRIGGER_ORDER_COOLDOWN_MS = 10000;

export class TriggerBot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly defaultIntervalMs: number = 1000;

	private driftClient: DriftClient;
	private slotSubscriber: SlotSubscriber;
	private blockhashSubscriber: BlockhashSubscriber;
	private userMap: UserMap;
	private triggerConfig: any;
	private globalConfig: any;
	private lookupTableAccounts?: AddressLookupTableAccount[];
	private dlobSubscriber?: DLOBSubscriber;
	private priorityFeeSubscriber: PriorityFeeSubscriber;
	private intervalIds: Array<NodeJS.Timer> = [];
	private triggeringNodes = new Map<string, number>();
	private watchdogTimerLastPatTime = Date.now();
	private busy = false;

	constructor(
		driftClient: DriftClient,
		slotSubscriber: SlotSubscriber,
		blockhashSubscriber: BlockhashSubscriber,
		userMap: UserMap,
		runtimeSpec: any,
		config: any,
		globalConfig: any,
		priorityFeeSubscriber: PriorityFeeSubscriber
	) {
		this.name = config.botId || 'trigger-bot';
		this.dryRun = !!config.dryRun;
		this.triggerConfig = config || {};
		this.globalConfig = globalConfig || {};
		this.driftClient = driftClient;
		this.slotSubscriber = slotSubscriber;
		this.blockhashSubscriber = blockhashSubscriber;
		this.userMap = userMap;
		this.priorityFeeSubscriber = priorityFeeSubscriber;
		logger.info(`[${this.name}] init dryRun=${this.dryRun} intervalMs=${this.defaultIntervalMs} feeMult=${this.triggerConfig.triggerPriorityFeeMultiplier ?? 1.0}`);
		this.priorityFeeSubscriber.updateAddresses([
			new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'),
			new PublicKey('8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W'),
		]);
	}

	public async init() {
		logger.info(`${this.name} initing (trigger cu boost: ${this.triggerConfig.triggerPriorityFeeMultiplier})`);
		this.dlobSubscriber = new DLOBSubscriber({
			dlobSource: this.userMap,
			slotSource: this.slotSubscriber,
			updateFrequency: this.defaultIntervalMs - 500,
			driftClient: this.driftClient,
		});
		await this.dlobSubscriber.subscribe();
		logger.info(`[${this.name}] DLOB subscribed interval=${this.defaultIntervalMs - 500}ms`);
		this.lookupTableAccounts = await this.driftClient.fetchAllLookupTableAccounts();
		logger.info(`[${this.name}] LUT count=${Array.isArray(this.lookupTableAccounts) ? this.lookupTableAccounts.length : 0}`);
	}

	public async reset() {
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId as NodeJS.Timeout);
		}
		this.intervalIds = [];
		await this.dlobSubscriber!.unsubscribe();
		await this.userMap!.unsubscribe();
	}

	public async startIntervalLoop(intervalMs?: number): Promise<void> {
		this.tryTrigger();
		const intervalId = setInterval(this.tryTrigger.bind(this), intervalMs ?? this.defaultIntervalMs);
		this.intervalIds.push(intervalId);
		logger.info(`${this.name} Bot started!`);
	}

	private removeTriggeringNodes(nodes: Array<NodeToTrigger>) {
		for (const node of nodes) {
			const sig = `${node.node.userAccount.toString()}-${node.node.order.orderId.toString()}`;
			this.triggeringNodes.delete(sig);
		}
	}

	private async tryTriggerForMarket(market: PerpMarketAccount | SpotMarketAccount, marketType: MarketType) {
		const marketIndex = market.marketIndex;
		const marketTypeStr = getVariant(marketType);
		try {
			const oraclePriceData = isVariant(marketType, 'perp')
				? this.driftClient.getOracleDataForPerpMarket(marketIndex)
				: this.driftClient.getOracleDataForSpotMarket(marketIndex);
			let triggerPrice = oraclePriceData.price;
			if (isVariant(marketType, 'perp')) {
				triggerPrice = getTriggerPrice(
					market as PerpMarketAccount,
					oraclePriceData.price,
					new BN(Date.now() / 1000),
					useMedianTriggerPrice(this.driftClient.getStateAccount())
				);
			}
			const dlob = this.dlobSubscriber!.getDLOB();
			const nodesToTrigger = dlob.findNodesToTrigger(
				marketIndex,
				this.slotSubscriber.getSlot(),
				triggerPrice,
				marketType,
				this.driftClient.getStateAccount()
			);
			logger.info(`[${this.name}] market=${marketTypeStr}-${marketIndex} nodesToTrigger=${nodesToTrigger.length}`);
			for (const nodeToTrigger of nodesToTrigger) {
				const now = Date.now();
				const nodeSig = `${nodeToTrigger.node.userAccount.toString()}-${nodeToTrigger.node.order.orderId.toString()}`;
				const last = this.triggeringNodes.get(nodeSig);
				if (last && last + TRIGGER_ORDER_COOLDOWN_MS > now) {
					logger.info(`[${this.name}] cooldown skip node=${nodeSig} waitedMs=${now - last}`);
					continue;
				}
				if (nodeToTrigger.node.haveTrigger) continue;
				nodeToTrigger.node.haveTrigger = true;
				this.triggeringNodes.set(nodeSig, now);

				const user = await this.userMap!.mustGet(nodeToTrigger.node.userAccount.toString());
				let cuUnits = 100_000;
				const activePositions = user.getActivePerpPositions().length + user.getActiveSpotPositions().length;
				const openOrders = user.getUserAccount().openOrders;
				cuUnits += activePositions * 15_000;
				cuUnits += openOrders * 5_000;

				let ixs: TransactionInstruction[] = [
					ComputeBudgetProgram.setComputeUnitLimit({ units: cuUnits }),
					ComputeBudgetProgram.setComputeUnitPrice({
						microLamports: Math.floor(
							this.priorityFeeSubscriber.getCustomStrategyResult() *
								this.driftClient.txSender.getSuggestedPriorityFeeMultiplier() *
								(this.triggerConfig.triggerPriorityFeeMultiplier ?? 1.0)
						),
					}),
				];
				ixs.push(
					await this.driftClient.getTriggerOrderIx(
						new PublicKey(nodeToTrigger.node.userAccount),
						user.getUserAccount(),
						nodeToTrigger.node.order
					)
				);

				if (this.dryRun) {
					logger.info(`[${this.name}] dry run, skipping send`);
					this.removeTriggeringNodes([nodeToTrigger]);
					continue;
				}

				try {
					const { blockhash } = await this.driftClient.connection.getLatestBlockhash('confirmed');
					const msg = new TransactionMessage({ payerKey: this.driftClient.wallet.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(this.lookupTableAccounts || []);
					const tx = new VersionedTransaction(msg);
					// @ts-ignore
					tx.sign([this.driftClient.wallet.payer]);
					const sig = await this.driftClient.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
					logger.info(`[${this.name}] triggered ok sig=${sig} cuUnits=${cuUnits}`);
				} catch (e) {
					logger.error(`Error triggering order: ${String((e as any)?.message || e)}`);
				} finally {
					this.removeTriggeringNodes([nodeToTrigger]);
				}
			}
		} catch (e) {
			logger.error(`Unexpected error for ${marketTypeStr} market ${marketIndex.toString()} during triggers`);
			console.error(e);
		}
	}

	private async tryTrigger() {
		if (this.busy) return;
		this.busy = true;
		try {
			await Promise.all([
				this.driftClient.getPerpMarketAccounts().map((m) => this.tryTriggerForMarket(m, MarketType.PERP)),
				this.driftClient.getSpotMarketAccounts().map((m) => this.tryTriggerForMarket(m, MarketType.SPOT)),
			]);
			this.watchdogTimerLastPatTime = Date.now();
		} finally {
			this.busy = false;
		}
	}
}


