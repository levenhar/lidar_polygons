import React from 'react';
import './AnchorPointWarningModal.css';

interface AnchorPointWarningModalProps {
  isOpen: boolean;
  affectedClimbsCount: number;
  onCancel: () => void;
  onContinue: () => void;
}

const AnchorPointWarningModal: React.FC<AnchorPointWarningModalProps> = ({
  isOpen,
  affectedClimbsCount,
  onCancel,
  onContinue
}) => {
  if (!isOpen) return null;

  return (
    <div className="anchor-warning-modal-overlay" onClick={onCancel}>
      <div className="anchor-warning-modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="anchor-warning-modal-title">אזהרה: עריכת נקודת עוגן</h2>
        <p className="anchor-warning-modal-message">
          עריכת נקודה זו תמחק {affectedClimbsCount} נקודת{' '}
          {affectedClimbsCount === 1 ? 'עלייה' : 'עלייה'} במסלול הרלוונטי.
        </p>
        <p className="anchor-warning-modal-submessage">
          נקודות עלייה נקשרות לקטע מסוים במסלול. כאשר נקודת העוגן של קטע משתנה או נמחקת,
          נקודות העלייה על אותו קטע נמחקות.
        </p>
        <div className="anchor-warning-modal-buttons">
          <button
            className="anchor-warning-modal-button anchor-warning-modal-button-cancel"
            onClick={onCancel}
          >
            ביטול
          </button>
          <button
            className="anchor-warning-modal-button anchor-warning-modal-button-continue"
            onClick={onContinue}
          >
            המשך
          </button>
        </div>
      </div>
    </div>
  );
};

export default AnchorPointWarningModal;

