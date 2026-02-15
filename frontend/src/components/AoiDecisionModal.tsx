import React, { useEffect } from 'react';
import './AoiDecisionModal.css';

interface AoiDecisionModalProps {
  isOpen: boolean;
  onReplace: () => void;
  onAddAsOverlay: () => void;
}

const AoiDecisionModal: React.FC<AoiDecisionModalProps> = ({
  isOpen,
  onReplace,
  onAddAsOverlay
}) => {
  // Handle Enter key to replace AOI (primary action)
  useEffect(() => {
    if (!isOpen) return;

    const handleEnter = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onReplace();
      }
    };

    document.addEventListener('keydown', handleEnter);
    return () => {
      document.removeEventListener('keydown', handleEnter);
    };
  }, [isOpen, onReplace]);

  if (!isOpen) return null;

  return (
    <div className="aoi-decision-modal__backdrop" role="dialog" aria-modal="true">
      <div className="aoi-decision-modal__card">
        <div className="aoi-decision-modal__header">
          <h2 className="aoi-decision-modal__title">קיים AOI פעיל</h2>
        </div>

        <div className="aoi-decision-modal__body">
          <p className="aoi-decision-modal__message">
            קיים כבר AOI פעיל במפה. כיצד תרצה להמשיך?
          </p>
        </div>

        <div className="aoi-decision-modal__actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onAddAsOverlay}
          >
            הוסף כשכבת overlay
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onReplace}
          >
            החלף את ה-AOI הנוכחי
          </button>
        </div>
      </div>
    </div>
  );
};

export default AoiDecisionModal;


