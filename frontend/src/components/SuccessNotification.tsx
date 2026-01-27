import React, { useEffect } from 'react';
import './SuccessNotification.css';

interface SuccessNotificationProps {
  isOpen: boolean;
  message: string;
  onClose: () => void;
  autoCloseDelay?: number; // milliseconds, default 3000
}

const SuccessNotification: React.FC<SuccessNotificationProps> = ({
  isOpen,
  message,
  onClose,
  autoCloseDelay = 3000
}) => {
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        onClose();
      }, autoCloseDelay);

      return () => clearTimeout(timer);
    }
  }, [isOpen, autoCloseDelay, onClose]);

  if (!isOpen) return null;

  return (
    <div className="success-notification-overlay" onClick={onClose}>
      <div className="success-notification-content" onClick={(e) => e.stopPropagation()}>
        <div className="success-notification-icon">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="success-notification-message">{message}</div>
        <button className="success-notification-close" onClick={onClose}>
          ×
        </button>
      </div>
    </div>
  );
};

export default SuccessNotification;

