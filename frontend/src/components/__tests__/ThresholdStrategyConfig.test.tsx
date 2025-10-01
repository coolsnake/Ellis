import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThresholdStrategyConfig } from '../ThresholdStrategyConfig';

describe('ThresholdStrategyConfig', () => {
  const mockOnSave = jest.fn();
  const mockOnCancel = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the configuration form', () => {
    render(
      <ThresholdStrategyConfig
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText('Threshold Strategy Configuration')).toBeInTheDocument();
    expect(screen.getByLabelText('Strategy Name')).toBeInTheDocument();
    expect(screen.getByLabelText('From Token')).toBeInTheDocument();
    expect(screen.getByLabelText('To Token')).toBeInTheDocument();
  });

  it('populates form with initial config', () => {
    const initialConfig = {
      name: 'test-strategy',
      fromToken: 'USDC',
      toToken: 'SOL',
      buyPct: 0.01,
      sellPct: 0.02
    };

    render(
      <ThresholdStrategyConfig
        onSave={mockOnSave}
        onCancel={mockOnCancel}
        initialConfig={initialConfig}
      />
    );

    expect(screen.getByDisplayValue('test-strategy')).toBeInTheDocument();
    expect(screen.getByDisplayValue('USDC')).toBeInTheDocument();
    expect(screen.getByDisplayValue('SOL')).toBeInTheDocument();
  });

  it('calls onSave with form data when submitted', () => {
    render(
      <ThresholdStrategyConfig
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    fireEvent.change(screen.getByLabelText('Strategy Name'), { target: { value: 'new-strategy' } });
    fireEvent.change(screen.getByLabelText('From Token'), { target: { value: 'USDC' } });
    fireEvent.change(screen.getByLabelText('To Token'), { target: { value: 'SOL' } });
    fireEvent.change(screen.getByLabelText('Buy Threshold (%)'), { target: { value: '0.01' } });
    fireEvent.change(screen.getByLabelText('Sell Threshold (%)'), { target: { value: '0.02' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.1' } });

    fireEvent.click(screen.getByText('Save Strategy'));

    expect(mockOnSave).toHaveBeenCalledWith({
      name: 'new-strategy',
      fromToken: 'USDC',
      toToken: 'SOL',
      active: true,
      testMode: false,
      buyPct: 0.01,
      sellPct: 0.02,
      amount: 0.1,
      marketEnter: null,
      fixedAnchor: false,
      anchorPairAtSetup: 0,
      scaleAggressiveness: 0.5,
      scaleStepPct: 0.01,
      slippageBps: 100,
      maxOpenPositions: 3,
      maxPositionSize: 1.0,
      lst: false,
      navSource: 'protocol',
      hysteresisBps: 50,
      cooldownMs: 1000,
      feeBps: 30,
      extraSlippageBps: 50,
      minEdgeBps: 60,
      slidingAnchor: false,
      slideRateBpsPerSec: 1,
      slideMaxPct: 0.01,
    });
  });

  it('calls onCancel when cancel button is clicked', () => {
    render(
      <ThresholdStrategyConfig
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    fireEvent.click(screen.getByText('Cancel'));

    expect(mockOnCancel).toHaveBeenCalled();
  });
});
