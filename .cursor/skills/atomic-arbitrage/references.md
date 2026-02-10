# Research References

## Foundational Papers

### Cyclic Arbitrage

**Wang, Chen, Wu, Zhou, Deng, Wattenhofer (2021)**
"Cyclic Arbitrage in Decentralized Exchanges"

- arXiv: https://arxiv.org/abs/2105.02784
- Key findings:
  - 292,606 cyclic arbitrages on Uniswap V2 over 11 months
  - >$138M in revenue exploited
  - Persistent unexploited opportunities >1 ETH suggest market inefficiency
  - Atomic implementations mitigate price impact losses

---

### Non-Atomic Arbitrage

**Heimbach, Pahari, Schertenleib (2024)**
"Non-Atomic Arbitrage in Decentralized Finance"
*IEEE Symposium on Security and Privacy (S&P) 2024*

- arXiv: https://arxiv.org/abs/2401.01622
- Key findings:
  - >25% of volume on top 5 Ethereum DEXs is non-atomic arbitrage
  - $132 billion in non-atomic arbitrage volume identified
  - Only 11 searchers responsible for >80% of volume
  - Connection between block builder centralization and non-atomic MEV

---

### Flash Loans

**Qin, Zhou, Livshits, Gervais (2021)**
"Attacking the DeFi Ecosystem with Flash Loans for Fun and Profit"
*Financial Cryptography and Data Security (FC) 2021*

- PDF: https://www.doc.ic.ac.uk/~livshits/papers/pdf/fc21b.pdf
- Also: https://arxiv.org/abs/2003.03810
- Key findings:
  - First systematic investigation of flash loans
  - Attacks demonstrated with >500,000% returns
  - Formulated attack optimization as mathematical problem
  - Showed existing attacks could be "boosted" 1.7-2.4×

**Cao, Zou, et al. (2021)**
"Flashot: A Snapshot of Flash Loan Attack on DeFi Ecosystem"

- arXiv: https://arxiv.org/abs/2102.00626
- Key findings:
  - First standardized framework for illustrating flash loan asset flows
  - Analysis of "pump and arbitrage" attack patterns

---

### MEV (Maximal Extractable Value)

**Daian, Goldfeder, Kell, Li, Zhao, Bentov, Breidenbach, Juels (2020)**
"Flash Boys 2.0: Frontrunning in Decentralized Exchanges, Miner Extractable Value, and Consensus Instability"
*IEEE Symposium on Security and Privacy (S&P) 2020*

- arXiv: https://arxiv.org/abs/1904.05234
- Key findings:
  - Introduced "Miner Extractable Value" concept
  - Documented priority gas auctions (PGAs)
  - Showed MEV poses risks to consensus security
  - Foundation for subsequent MEV research

**Weintraub, Ferreira Torres, et al. (2024)**
"Blockchain Censorship"

- arXiv: https://arxiv.org/abs/2305.18545
- Key findings:
  - ~$675M MEV extracted on Ethereum before September 2022
  - Characterization of post-Merge MEV ecosystem

---

### AMM Mathematics

**Angeris, Kao, Chiang, Noyes, Chitra (2019)**
"An Analysis of Uniswap Markets"

- PDF: https://angeris.github.io/papers/uniswap_analysis.pdf
- Published: Cryptoeconomic Systems Journal
- Key findings:
  - Formal analysis of constant product markets
  - Proved CPMMs closely track reference prices
  - Stability analysis under various conditions

**Angeris, Evans, Chitra (2024)**
"Closed-form solutions for generic N-token AMM arbitrage"

- arXiv: https://arxiv.org/abs/2402.06731
- Key findings:
  - Analytical (closed-form) solutions for multi-token AMM arbitrage
  - Outperforms numerical optimization in testing
  - GPU-parallelizable due to fixed operation count
  - Enables efficient on-chain arbitrage bots

**Angeris, Chitra (2024)**
"Optimal Fees for Geometric Mean Market Makers"

- PDF: https://angeris.github.io/papers/g3m-optimal-fee.pdf
- Key findings:
  - Tradeoff between LP compensation and price efficiency
  - Faster blockchains reduce LP losses from arbitrage

---

### Concentrated Liquidity (CLMM)

**Adams, Zinsmeister, Salem, Keefer, Robinson (2021)**
"Uniswap V3 Whitepaper"

- PDF: https://uniswap.org/whitepaper-v3.pdf
- Key concepts:
  - Concentrated liquidity within price ranges
  - Tick-based price discretization
  - Non-fungible liquidity positions

**Atis (2021)**
"Liquidity Math in Uniswap V3"

- PDF: https://atiselsts.github.io/pdfs/uniswap-v3-liquidity-math.pdf
- Key concepts:
  - Detailed mathematical derivations
  - Swap calculations within/across ticks
  - Position value calculations

**Lipton, Lucic (2024)**
"A mathematical framework for modelling CLMM dynamics in continuous time"

- arXiv: https://arxiv.org/abs/2412.18580
- Key findings:
  - Rigorous continuous-time models
  - Fees constrain price process (preclude diffusion)
  - Closed-form optimal arbitrage strategies

**Just-In-Time Liquidity Research (2024)**

- arXiv: https://arxiv.org/abs/2509.16157
- Key findings:
  - JIT strategies often fail to account for price impact
  - Potential 69% earnings increase with proper modeling

---

### Routing Optimization

**Gauntlet Research**
"An Efficient Algorithm for Optimal Routing Through Constant Function Market Makers"

- URL: https://www.gauntlet.xyz/resources/an-efficient-algorithm-for-optimal-routing-through-constant-function-market-makers
- Key concepts:
  - Decomposition-based routing algorithm
  - Significant speedup vs commercial solvers
  - Practical for real-time DEX routing

---

### Algorithm References

**SPFA Negative Cycle Detection**

- URL: https://konaeakira.github.io/posts/using-the-shortest-path-faster-algorithm-to-find-negative-cycles.html
- Key concepts:
  - O(E) average complexity
  - Path-length tracking for cycle detection
  - Practical implementation details

**Bellman-Ford for Currency Arbitrage**

- Princeton Algorithms: https://algs4.cs.princeton.edu/code/javadoc/edu/princeton/cs/algs4/Arbitrage.html
- Key concepts:
  - Log-space transformation for multiplicative to additive
  - Negative cycle = arbitrage opportunity

---

## Solana-Specific Resources

### Jito MEV

**Jito Labs Documentation**
- Bundles: https://jito-labs.gitbook.io/mev/searcher-resources/bundles
- Systems: https://jito-foundation.gitbook.io/mev/solana-mev/systems

**Jito MEV Dashboard**
- URL: https://www.jito.wtf/blog/introducing-the-first-solana-mev-dashboard/
- Key statistics:
  - >96% of arbitrage attempts fail
  - Median USDC arbitrage profit: $0.0168 (early 2022)

**Analysis Article**
- "Solana MEV: A Deep Dive Into Jito and the Future of Arbitrage"
- URL: https://sanj.dev/post/solana-mev-jito-deep-dive

---

## Cross-Chain / Layer 2

**Obadia, Salles, Sanchez, Strietzen, Livshits (2024)**
"Cross-Rollup MEV: Non-Atomic Arbitrage Across L2 Blockchains"

- arXiv: https://arxiv.org/abs/2406.02172
- Key findings:
  - >500,000 unexploited arbitrage opportunities across L2s
  - Opportunities persist 10-20 blocks on average
  - Profits 0.03%-0.25% of volume depending on rollup

---

## Additional Reading

### Slippage and Price Impact

**Integral Research**
"Slippage and Price Impact in DeFi Explained"
- URL: https://integral.link/slippage-and-price-impact-in-defi-explained

### Market Microstructure

**Capponi, Jia (2024)**
"The Adoption of Blockchain-based Decentralized Exchanges"

- arXiv: https://arxiv.org/abs/2103.08842
- Analysis of DEX market structure and efficiency

---

## Citation Format

When referencing these papers:

```
[Author Year] - Short description
Example: [Wang 2021] - Cyclic arbitrage analysis on Uniswap V2
```
