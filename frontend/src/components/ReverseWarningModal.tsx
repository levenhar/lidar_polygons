import React, { useEffect } from 'react';
import './ReverseWarningModal.css';

interface ReverseWarningModalProps {
  isOpen: boolean;
  onCancel: () => void;
  onContinue: () => void;
}

const ReverseWarningModal: React.FC<ReverseWarningModalProps> = ({
  isOpen,
  onCancel,
  onContinue
}) => {
  useEffect(() => {
    if (!isOpen) return;

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onContinue();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen, onCancel, onContinue]);

  if (!isOpen) return null;

  return (
    <div className="reverse-warning-modal-overlay" onClick={onCancel}>
      <div className="reverse-warning-modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="reverse-warning-modal-title">הפוך כיוון מסלול</h2>
        <p className="reverse-warning-modal-message">
          פעולה זו תמחק את כל נקודות העלייה/ירידה במסלול. האם להמשיך?
        </p>
        <div className="reverse-warning-modal-buttons">
          <button
            className="reverse-warning-modal-button reverse-warning-modal-button-cancel"
            onClick={onCancel}
          >
            ביטול
          </button>
          <button
            className="reverse-warning-modal-button reverse-warning-modal-button-continue"
            onClick={onContinue}
          >
            המשך
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReverseWarningModal;
