import { render, screen, fireEvent } from '@testing-library/react';
import ReverseWarningModal from './ReverseWarningModal';

describe('ReverseWarningModal', () => {
  it('returns null when not open', () => {
    const { container } = render(
      <ReverseWarningModal
        isOpen={false}
        onCancel={() => {}}
        onContinue={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the title and message when open', () => {
    render(
      <ReverseWarningModal
        isOpen={true}
        onCancel={() => {}}
        onContinue={() => {}}
      />
    );
    expect(screen.getByText('הפוך כיוון מסלול')).toBeInTheDocument();
    expect(screen.getByText(/תמחק את כל נקודות העלייה/)).toBeInTheDocument();
  });

  it('calls onContinue when continue button clicked', () => {
    const onContinue = vi.fn();
    render(
      <ReverseWarningModal
        isOpen={true}
        onCancel={() => {}}
        onContinue={onContinue}
      />
    );
    fireEvent.click(screen.getByText('המשך'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button clicked', () => {
    const onCancel = vi.fn();
    render(
      <ReverseWarningModal
        isOpen={true}
        onCancel={onCancel}
        onContinue={() => {}}
      />
    );
    fireEvent.click(screen.getByText('ביטול'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when overlay is clicked', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ReverseWarningModal
        isOpen={true}
        onCancel={onCancel}
        onContinue={() => {}}
      />
    );
    fireEvent.click(container.firstChild!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onContinue when Enter key is pressed', () => {
    const onContinue = vi.fn();
    render(
      <ReverseWarningModal
        isOpen={true}
        onCancel={() => {}}
        onContinue={onContinue}
      />
    );
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Escape key is pressed', () => {
    const onCancel = vi.fn();
    render(
      <ReverseWarningModal
        isOpen={true}
        onCancel={onCancel}
        onContinue={() => {}}
      />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
