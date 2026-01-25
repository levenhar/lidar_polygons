import React, { useRef, useEffect } from 'react';
import { LocalDtmDescriptor, validateLocalDtmFile } from '../utils/projectSerializer';
import './MissingLocalDTMModal.css';

interface MissingLocalDTMModalProps {
  isOpen: boolean;
  descriptor: LocalDtmDescriptor;
  onFileSelected: (file: File) => void;
  onCancel: () => void;
}

const MissingLocalDTMModal: React.FC<MissingLocalDTMModalProps> = ({
  isOpen,
  descriptor,
  onFileSelected,
  onCancel
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [isValidating, setIsValidating] = React.useState(false);

  useEffect(() => {
    if (isOpen && fileInputRef.current) {
      // Reset file input when modal opens
      fileInputRef.current.value = '';
      setValidationError(null);
    }
  }, [isOpen]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsValidating(true);
    setValidationError(null);

    try {
      // Validate file matches descriptor
      const validation = validateLocalDtmFile(file, descriptor);
      
      if (!validation.matches) {
        setValidationError(
          `אימות הקובץ נכשל:\n${validation.errors.join('\n')}\n\n` +
          'אנא בחר את הקובץ הנכון. הקובץ חייב להתאים לשם המקורי, לגודל ולמועד השינוי.'
        );
        setIsValidating(false);
        return;
      }

      // File matches, proceed
      setIsValidating(false);
      onFileSelected(file);
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : 'אימות הקובץ נכשל'
      );
      setIsValidating(false);
    }
  };

  const handleBrowse = () => {
    fileInputRef.current?.click();
  };

  if (!isOpen) return null;

  const fileSizeMB = (descriptor.fileSize / (1024 * 1024)).toFixed(2);
  const lastModifiedDate = new Date(descriptor.lastModified).toLocaleString();

  return (
    <div className="missing-dtm-modal__backdrop" role="dialog" aria-modal="true">
      <div className="missing-dtm-modal__card">
        <div className="missing-dtm-modal__header">
          <h2 className="missing-dtm-modal__title">נדרש קובץ DTM</h2>
          <button
            type="button"
            className="missing-dtm-modal__close"
            onClick={onCancel}
            aria-label="סגור"
          >
            ×
          </button>
        </div>

        <div className="missing-dtm-modal__body">
          <p className="missing-dtm-modal__message">
            פרויקט זה משתמש בקובץ DTM מקומי שאינו זמין במחשב זה.
            אנא בחר את קובץ ה-DTM המקורי כדי לשחזר את הפרויקט.
          </p>

          <div className="missing-dtm-modal__file-info">
            <div className="missing-dtm-modal__info-row">
              <span className="missing-dtm-modal__info-label">קובץ צפוי:</span>
              <span className="missing-dtm-modal__info-value">{descriptor.originalFileName}</span>
            </div>
            <div className="missing-dtm-modal__info-row">
              <span className="missing-dtm-modal__info-label">גודל קובץ:</span>
              <span className="missing-dtm-modal__info-value">{fileSizeMB} MB</span>
            </div>
            <div className="missing-dtm-modal__info-row">
              <span className="missing-dtm-modal__info-label">שונה לאחרונה:</span>
              <span className="missing-dtm-modal__info-value">{lastModifiedDate}</span>
            </div>
          </div>

          <div className="missing-dtm-modal__constraints">
            <p className="missing-dtm-modal__constraints-title">דרישות:</p>
            <ul className="missing-dtm-modal__constraints-list">
              <li>הקובץ חייב להיות GeoTIFF (.tif, .tiff, .geotiff)</li>
              <li>גודל הקובץ חייב להיות פחות מ-2GB</li>
              <li>הקובץ חייב להתאים לשם המקורי, לגודל ולמועד השינוי</li>
            </ul>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".tif,.tiff,.geotiff"
            onChange={handleFileChange}
            style={{ display: 'none' }}
            aria-label="בחר קובץ DTM"
          />

          {validationError && (
            <div className="missing-dtm-modal__error" role="alert">
              {validationError.split('\n').map((line, i) => (
                <React.Fragment key={i}>
                  {line}
                  {i < validationError.split('\n').length - 1 && <br />}
                </React.Fragment>
              ))}
            </div>
          )}

          {isValidating && (
            <div className="missing-dtm-modal__validating">
              בודק קובץ...
            </div>
          )}
        </div>

        <div className="missing-dtm-modal__actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
            disabled={isValidating}
          >
            ביטול
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleBrowse}
            disabled={isValidating}
          >
            בחר קובץ DTM (.tif)
          </button>
        </div>
      </div>
    </div>
  );
};

export default MissingLocalDTMModal;

