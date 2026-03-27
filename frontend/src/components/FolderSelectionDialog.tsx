import React, { useState, useEffect, useCallback } from 'react';
import './FolderSelectionDialog.css';

interface FolderSelectionDialogProps {
  isOpen: boolean;
  currentFolderLabel?: string;
  onClose: () => void;
  onSelectFolder: () => Promise<void>;
  onUseExistingFolder: () => Promise<void>;
}

const FolderSelectionDialog: React.FC<FolderSelectionDialogProps> = ({
  isOpen,
  currentFolderLabel,
  onClose,
  onSelectFolder,
  onUseExistingFolder
}) => {
  const [isSelecting, setIsSelecting] = useState(false);
  const [isUsingExisting, setIsUsingExisting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  const handleSelectNewFolder = useCallback(async () => {
    setIsSelecting(true);
    try {
      await onSelectFolder();
    } finally {
      setIsSelecting(false);
    }
  }, [onSelectFolder]);

  // Handle Enter key to select folder
  useEffect(() => {
    if (!isOpen) return;

    const handleEnter = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !isSelecting && !isUsingExisting) {
        event.preventDefault();
        handleSelectNewFolder();
      }
    };

    document.addEventListener('keydown', handleEnter);
    return () => {
      document.removeEventListener('keydown', handleEnter);
    };
  }, [isOpen, isSelecting, isUsingExisting, handleSelectNewFolder]);

  if (!isOpen) return null;

  const handleUseExisting = async () => {
    setIsUsingExisting(true);
    try {
      await onUseExistingFolder();
    } finally {
      setIsUsingExisting(false);
    }
  };

  return (
    <div className="folder-selection-dialog-overlay" onClick={onClose}>
      <div className="folder-selection-dialog-content" onClick={(e) => e.stopPropagation()}>
        <div className="folder-selection-dialog-header">
          <h2>בחר תיקיית יעד לייצוא</h2>
          <button className="folder-selection-dialog-close" onClick={onClose}>
            ×
          </button>
        </div>
        
        <div className="folder-selection-dialog-body">
          <p className="folder-selection-dialog-description">
            בחר תיקייה לשמירת קבצי ה-KML. כל המסלולים יישמרו בתיקייה זו עם שמות אוטומטיים.
          </p>
          
          {currentFolderLabel && (
            <div className="folder-selection-dialog-existing">
              <div className="folder-selection-dialog-existing-label">
                תיקייה נוכחית:
              </div>
              <div className="folder-selection-dialog-existing-value">
                {currentFolderLabel}
              </div>
              <button
                className="btn btn-secondary"
                onClick={handleUseExisting}
                disabled={isUsingExisting || isSelecting}
              >
                {isUsingExisting ? 'משתמש בתיקייה...' : 'השתמש בתיקייה זו'}
              </button>
            </div>
          )}
        </div>
        
        <div className="folder-selection-dialog-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={isSelecting || isUsingExisting}>
            ביטול
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSelectNewFolder}
            disabled={isSelecting || isUsingExisting}
          >
            {isSelecting ? 'בוחר תיקייה...' : currentFolderLabel ? 'בחר תיקייה אחרת' : 'בחר תיקייה'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FolderSelectionDialog;

