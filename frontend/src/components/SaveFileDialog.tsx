import React, { useState, useEffect, useRef } from 'react';
import { saveFileWithLocation } from '../utils/fileSave';
import './SaveFileDialog.css';

interface SaveFileDialogProps {
  isOpen: boolean;
  defaultFilename: string;
  fileExtension: string;
  title: string;
  description?: string;
  fileContent: string | Blob;
  mimeType?: string;
  onClose: () => void;
  onSave?: (filename: string) => void; // Optional legacy callback
}

const SaveFileDialog: React.FC<SaveFileDialogProps> = ({
  isOpen,
  defaultFilename,
  fileExtension,
  title,
  description,
  fileContent,
  mimeType,
  onClose,
  onSave
}) => {
  const [filename, setFilename] = useState(defaultFilename);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset filename when dialog opens
  useEffect(() => {
    if (isOpen) {
      setFilename(defaultFilename);
      setError(null);
      // Focus input after a short delay to ensure it's rendered
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 100);
      
      // Prevent body scrolling when modal is open
      document.body.style.overflow = 'hidden';
    } else {
      // Restore body scrolling when modal is closed
      document.body.style.overflow = '';
    }
    
    return () => {
      // Cleanup: restore body scrolling
      document.body.style.overflow = '';
    };
  }, [isOpen, defaultFilename]);

  // Handle ESC key to close modal
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

  // Early return after all hooks
  if (!isOpen) return null;

  const handleFilenameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setFilename(value);
    
    // Validate filename
    if (value.trim() === '') {
      setError('שם הקובץ לא יכול להיות ריק');
    } else if (/[<>:"/\\|?*]/.test(value)) {
      setError('שם הקובץ מכיל תווים לא חוקיים');
    } else {
      setError(null);
    }
  };

  const handleSave = async () => {
    const trimmedFilename = filename.trim();
    
    if (trimmedFilename === '') {
      setError('שם הקובץ לא יכול להיות ריק');
      return;
    }
    
    if (/[<>:"/\\|?*]/.test(trimmedFilename)) {
      setError('שם הקובץ מכיל תווים לא חוקיים');
      return;
    }
    
    // Ensure file extension is present
    let finalFilename = trimmedFilename;
    if (!finalFilename.toLowerCase().endsWith(fileExtension.toLowerCase())) {
      finalFilename = finalFilename + fileExtension;
    }
    
    try {
      // Use File System Access API to save with location selection
      await saveFileWithLocation(fileContent, finalFilename, mimeType);
      
      // Call legacy callback if provided (for backward compatibility)
      if (onSave) {
        onSave(finalFilename);
      }
      
      onClose();
    } catch (error: any) {
      if (error.message === 'User cancelled file save') {
        // User cancelled, just close the dialog
        onClose();
      } else {
        // Show error to user
        setError(`שגיאה בשמירת הקובץ: ${error.message || 'שגיאה לא ידועה'}`);
        console.error('Error saving file:', error);
      }
    }
  };

  const handleCancel = () => {
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <div className="save-file-dialog-overlay" onClick={handleCancel}>
      <div className="save-file-dialog-content" onClick={(e) => e.stopPropagation()}>
        <div className="save-file-dialog-header">
          <h2>{title}</h2>
          <button className="save-file-dialog-close" onClick={handleCancel}>
            ×
          </button>
        </div>
        
        <div className="save-file-dialog-body">
          {description && (
            <p className="save-file-dialog-description">
              {description}
            </p>
          )}
          
          <div className="save-file-dialog-input-group">
            <label className="save-file-dialog-label" htmlFor="filename-input">
              שם הקובץ:
            </label>
            <input
              ref={inputRef}
              id="filename-input"
              type="text"
              className={`save-file-dialog-input ${error ? 'error' : ''}`}
              value={filename}
              onChange={handleFilenameChange}
              onKeyDown={handleKeyDown}
              placeholder="הזן שם קובץ"
            />
            {error && (
              <div className="save-file-dialog-error" role="alert">
                {error}
              </div>
            )}
            <div className="save-file-dialog-hint">
              {('showSaveFilePicker' in window) 
                ? 'תוכל לבחור את המיקום לשמירת הקובץ'
                : 'הקובץ יישמר בתיקיית ההורדות של הדפדפן'}
            </div>
          </div>
        </div>
        
        <div className="save-file-dialog-footer">
          <button className="btn btn-secondary" onClick={handleCancel}>
            ביטול
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!!error || filename.trim() === ''}
          >
            שמור
          </button>
        </div>
      </div>
    </div>
  );
};

export default SaveFileDialog;

