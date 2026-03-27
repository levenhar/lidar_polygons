import { render, screen, fireEvent } from '@testing-library/react';
import AnchorPointWarningModal from './AnchorPointWarningModal';

describe('AnchorPointWarningModal', () => {
  it('returns null when not open', () => {
    const { container } = render(
      <AnchorPointWarningModal
        isOpen={false}
        affectedClimbsCount={2}
        onCancel={() => {}}
        onContinue={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('calls onContinue when continue button clicked', () => {
    const onContinue = vi.fn();
    render(
      <AnchorPointWarningModal
        isOpen={true}
        affectedClimbsCount={2}
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
      <AnchorPointWarningModal
        isOpen={true}
        affectedClimbsCount={1}
        onCancel={onCancel}
        onContinue={() => {}}
      />
    );
    fireEvent.click(screen.getByText('ביטול'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
