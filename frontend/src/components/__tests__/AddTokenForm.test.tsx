import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddTokenForm } from '../AddTokenForm';

describe('AddTokenForm', () => {
  const mockOnSave = jest.fn();
  const mockOnCancel = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the add token form', () => {
    render(
      <AddTokenForm
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    expect(screen.getByText('Add Token to Watchlist')).toBeInTheDocument();
    expect(screen.getByLabelText('Token Symbol')).toBeInTheDocument();
    expect(screen.getByLabelText('Token Mint (Optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('Token Name (Optional)')).toBeInTheDocument();
  });

  it('calls onSave with token data when submitted', () => {
    render(
      <AddTokenForm
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    fireEvent.change(screen.getByLabelText('Token Symbol'), { target: { value: 'SOL' } });
    fireEvent.change(screen.getByLabelText('Token Mint (Optional)'), { 
      target: { value: 'So11111111111111111111111111111111111111112' } 
    });
    fireEvent.change(screen.getByLabelText('Token Name (Optional)'), { 
      target: { value: 'Solana' } 
    });

    fireEvent.click(screen.getByText('Add Token'));

    expect(mockOnSave).toHaveBeenCalledWith({
      symbol: 'SOL',
      mint: 'So11111111111111111111111111111111111111112',
      name: 'Solana'
    });
  });

  it('calls onSave with minimal data when only symbol is provided', () => {
    render(
      <AddTokenForm
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    fireEvent.change(screen.getByLabelText('Token Symbol'), { target: { value: 'USDC' } });
    fireEvent.click(screen.getByText('Add Token'));

    expect(mockOnSave).toHaveBeenCalledWith({
      symbol: 'USDC',
      mint: undefined,
      name: undefined
    });
  });

  it('calls onCancel when cancel button is clicked', () => {
    render(
      <AddTokenForm
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    fireEvent.click(screen.getByText('Cancel'));

    expect(mockOnCancel).toHaveBeenCalled();
  });

  it('disables submit button when symbol is empty', () => {
    render(
      <AddTokenForm
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    const submitButton = screen.getByText('Add Token');
    expect(submitButton).toBeDisabled();
  });

  it('enables submit button when symbol is provided', () => {
    render(
      <AddTokenForm
        onSave={mockOnSave}
        onCancel={mockOnCancel}
      />
    );

    fireEvent.change(screen.getByLabelText('Token Symbol'), { target: { value: 'SOL' } });
    
    const submitButton = screen.getByText('Add Token');
    expect(submitButton).not.toBeDisabled();
  });
});
