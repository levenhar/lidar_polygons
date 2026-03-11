import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ClimbConfig, ClimbPreset } from '../utils/climb';
import './SettingsModal.css';

// Gear icon component
const GearIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M19.4 15C19.2669 15.3016 19.2272 15.6362 19.286 15.9606C19.3448 16.285 19.4995 16.5843 19.73 16.82L19.79 16.88C19.976 17.0657 20.1235 17.2863 20.2241 17.5291C20.3248 17.7719 20.3766 18.0322 20.3766 18.295C20.3766 18.5578 20.3248 18.8181 20.2241 19.0609C20.1235 19.3037 19.976 19.5243 19.79 19.71C19.6043 19.896 19.3837 20.0435 19.1409 20.1441C18.8981 20.2448 18.6378 20.2966 18.375 20.2966C18.1122 20.2966 17.8519 20.2448 17.6091 20.1441C17.3663 20.0435 17.1457 19.896 16.96 19.71L16.9 19.65C16.6643 19.4195 16.365 19.2648 16.0406 19.206C15.7162 19.1472 15.3816 19.1869 15.08 19.32C14.7842 19.4468 14.532 19.6572 14.3543 19.9255C14.1766 20.1938 14.0813 20.5082 14.08 20.83V21C14.08 21.5304 13.8693 22.0391 13.4942 22.4142C13.1191 22.7893 12.6104 23 12.08 23C11.5496 23 11.0409 22.7893 10.6658 22.4142C10.2907 22.0391 10.08 21.5304 10.08 21V20.91C10.0723 20.579 9.96512 20.258 9.77251 19.9887C9.5799 19.7194 9.31074 19.5143 9 19.4C8.69838 19.2669 8.36381 19.2272 8.03941 19.286C7.71502 19.3448 7.41568 19.4995 7.18 19.73L7.12 19.79C6.93425 19.976 6.71368 20.1235 6.47088 20.2241C6.22808 20.3248 5.96783 20.3766 5.705 20.3766C5.44217 20.3766 5.18192 20.3248 4.93912 20.2241C4.69632 20.1235 4.47575 19.976 4.29 19.79C4.10405 19.6043 3.95653 19.3837 3.85588 19.1409C3.75523 18.8981 3.70343 18.6378 3.70343 18.375C3.70343 18.1122 3.75523 17.8519 3.85588 17.6091C3.95653 17.3663 4.10405 17.1457 4.29 16.96L4.35 16.9C4.58054 16.6643 4.73519 16.365 4.794 16.0406C4.85282 15.7162 4.81312 15.3816 4.68 15.08C4.55324 14.7842 4.34276 14.532 4.07447 14.3543C3.80618 14.1766 3.49179 14.0813 3.17 14.08H3C2.46957 14.08 1.96086 13.8693 1.58579 13.4942C1.21071 13.1191 1 12.6104 1 12.08C1 11.5496 1.21071 11.0409 1.58579 10.6658C1.96086 10.2907 2.46957 10.08 3 10.08H3.09C3.42099 10.0723 3.742 9.96512 4.0113 9.77251C4.28059 9.5799 4.48572 9.31074 4.6 9C4.73312 8.69838 4.77282 8.36381 4.714 8.03941C4.65519 7.71502 4.50054 7.41568 4.27 7.18L4.21 7.12C4.02405 6.93425 3.87653 6.71368 3.77588 6.47088C3.67523 6.22808 3.62343 5.96783 3.62343 5.705C3.62343 5.44217 3.67523 5.18192 3.77588 4.93912C3.87653 4.69632 4.02405 4.47575 4.21 4.29C4.39575 4.10405 4.61632 3.95653 4.85912 3.85588C5.10192 3.75523 5.36217 3.70343 5.625 3.70343C5.88783 3.70343 6.14808 3.75523 6.39088 3.85588C6.63368 3.95653 6.85425 4.10405 7.04 4.29L7.1 4.35C7.33568 4.58054 7.63502 4.73519 7.95941 4.794C8.28381 4.85282 8.61838 4.81312 8.92 4.68H9C9.29577 4.55324 9.54802 4.34276 9.72569 4.07447C9.90337 3.80618 9.99872 3.49179 10 3.17V3C10 2.46957 10.2107 1.96086 10.5858 1.58579C10.9609 1.21071 11.4696 1 12 1C12.5304 1 13.0391 1.21071 13.4142 1.58579C13.7893 1.96086 14 2.46957 14 3V3.09C14.0013 3.41179 14.0966 3.72618 14.2743 3.99447C14.452 4.26276 14.7042 4.47324 15 4.6C15.3016 4.73312 15.6362 4.77282 15.9606 4.714C16.285 4.65519 16.5843 4.50054 16.82 4.27L16.88 4.21C17.0657 4.02405 17.2863 3.87653 17.5291 3.77588C17.7719 3.67523 18.0322 3.62343 18.295 3.62343C18.5578 3.62343 18.8181 3.67523 19.0609 3.77588C19.3037 3.87653 19.5243 4.02405 19.71 4.21C19.896 4.39575 20.0435 4.61632 20.1441 4.85912C20.2448 5.10192 20.2966 5.36217 20.2966 5.625C20.2966 5.88783 20.2448 6.14808 20.1441 6.39088C20.0435 6.63368 19.896 6.85425 19.71 7.04L19.65 7.1C19.4195 7.33568 19.2648 7.63502 19.206 7.95941C19.1472 8.28381 19.1869 8.61838 19.32 8.92V9C19.4468 9.29577 19.6572 9.54802 19.9255 9.72569C20.1938 9.90337 20.5082 9.99872 20.83 10H21C21.5304 10 22.0391 10.2107 22.4142 10.5858C22.7893 10.9609 23 11.4696 23 12C23 12.5304 22.7893 13.0391 22.4142 13.4142C22.0391 13.7893 21.5304 14 21 14H20.91C20.5882 14.0013 20.2738 14.0966 20.0055 14.2743C19.7372 14.452 19.5268 14.7042 19.4 15Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

type TabId = 'general' | 'mission' | 'ascend-descend' | 'shortcuts';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  // General settings
  safetyRadius: number;
  setSafetyRadius: (value: number) => void;
  safetyHeight: number;
  setSafetyHeight: (value: number) => void;
  outputHeight: number;
  setOutputHeight: (value: number) => void;
  // Mission settings
  overlapPercentage: number;
  setOverlapPercentage: (value: number) => void;
  fovDegrees: number;
  setFovDegrees: (value: number) => void;
  // Climb settings
  climbPresets: ClimbPreset[];
  selectedClimbPresetId: string;
  onSelectClimbPreset: (presetId: string) => void;
  climbConfig: ClimbConfig;
  setClimbConfig: React.Dispatch<React.SetStateAction<ClimbConfig>>;
}

// Helper to convert ClimbConfig to draft state for editing
const toDraft = (config: ClimbConfig) => ({
  climbRatio: config.climbRatio.toString(),
  descentRatio: config.descentRatio.toString(),
  allowTurnsDuringClimb: config.allowTurnsDuringClimb,
  linkRatios: config.linkRatios,
  vertexProximityMeters: config.vertexProximityMeters.toString(),
  minClimb: config.minClimb.toString(),
  maxClimb: config.maxClimb.toString()
});

// Validation types
interface ValidationError {
  field: string;
  message: string;
}

const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  safetyRadius,
  setSafetyRadius,
  safetyHeight,
  setSafetyHeight,
  outputHeight,
  setOutputHeight,
  overlapPercentage,
  setOverlapPercentage,
  fovDegrees,
  setFovDegrees,
  climbPresets,
  selectedClimbPresetId,
  onSelectClimbPreset,
  climbConfig,
  setClimbConfig
}) => {
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const mouseDownTargetRef = useRef<EventTarget | null>(null);

  // Draft state for all settings (allows Cancel to discard changes)
  const [generalDraft, setGeneralDraft] = useState({
    safetyRadius: safetyRadius.toString(),
    safetyHeight: safetyHeight.toString(),
    outputHeight: outputHeight.toString()
  });

  const [missionDraft, setMissionDraft] = useState({
    overlapPercentage: overlapPercentage.toString(),
    fovDegrees: fovDegrees.toString()
  });

  const [climbDraft, setClimbDraft] = useState(() => toDraft(climbConfig));
  const [selectedPresetId, setSelectedPresetId] = useState(selectedClimbPresetId);

  // Reset draft values when modal opens
  useEffect(() => {
    if (isOpen) {
      setGeneralDraft({
        safetyRadius: safetyRadius.toString(),
        safetyHeight: safetyHeight.toString(),
        outputHeight: outputHeight.toString()
      });

      setMissionDraft({
        overlapPercentage: overlapPercentage.toString(),
        fovDegrees: fovDegrees.toString()
      });
      setClimbDraft(toDraft(climbConfig));
      setSelectedPresetId(selectedClimbPresetId);
      setErrors([]);
      setActiveTab('general');

      // Prevent body scrolling when modal is open
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen, safetyRadius, safetyHeight, outputHeight, overlapPercentage, fovDegrees, climbConfig, selectedClimbPresetId]);

  // Focus first input when tab changes
  useEffect(() => {
    if (isOpen && firstInputRef.current) {
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }
  }, [isOpen, activeTab]);

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

  // Focus trap
  useEffect(() => {
    if (!isOpen || !modalRef.current) return;

    const modal = modalRef.current;
    const focusableElements = modal.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };

    document.addEventListener('keydown', handleTab);
    return () => document.removeEventListener('keydown', handleTab);
  }, [isOpen]);

  const validateAll = useCallback((): boolean => {
    const newErrors: ValidationError[] = [];

    // General validations
    const safetyRad = parseFloat(generalDraft.safetyRadius);
    if (isNaN(safetyRad) || safetyRad < 1) {
      newErrors.push({ field: 'safetyRadius', message: 'רדיוס בטיחות חייב להיות לפחות 1' });
    }

    const safetyH = parseFloat(generalDraft.safetyHeight);
    if (isNaN(safetyH) || safetyH < 0) {
      if (generalDraft.safetyHeight.trim() !== '') {
        newErrors.push({ field: 'safetyHeight', message: 'גובה בטיחות חייב להיות מספר חיובי' });
      }
    }

    const outputH = parseFloat(generalDraft.outputHeight);
    if (isNaN(outputH) || outputH < 0) {
      newErrors.push({ field: 'outputHeight', message: 'גובה תוצר חייב להיות מספר חיובי' });
    }

    // Mission validations
    const overlap = parseFloat(missionDraft.overlapPercentage);
    if (isNaN(overlap) || overlap < 0 || overlap > 100) {
      newErrors.push({ field: 'overlapPercentage', message: 'אחוז חפיפה חייב להיות בין 0 ל-100' });
    }

    const fov = parseFloat(missionDraft.fovDegrees);
    if (isNaN(fov) || fov < 1 || fov > 179) {
      newErrors.push({ field: 'fovDegrees', message: 'שדה ראייה חייב להיות בין 1 ל-179' });
    }

    // Climb config validations
    const climbRatio = parseFloat(climbDraft.climbRatio);
    if (isNaN(climbRatio) || climbRatio <= 0) {
      newErrors.push({ field: 'climbRatio', message: 'יחס עלייה חייב להיות גדול מ-0' });
    }

    const descentRatio = parseFloat(climbDraft.descentRatio);
    if (isNaN(descentRatio) || descentRatio <= 0) {
      newErrors.push({ field: 'descentRatio', message: 'יחס ירידה חייב להיות גדול מ-0' });
    }

    const vertexProximity = parseFloat(climbDraft.vertexProximityMeters);
    if (isNaN(vertexProximity) || vertexProximity < 0) {
      newErrors.push({ field: 'vertexProximityMeters', message: 'קרבת קודקוד חייבת להיות 0 או יותר' });
    }

    const minClimb = parseFloat(climbDraft.minClimb);
    const maxClimb = parseFloat(climbDraft.maxClimb);
    if (isNaN(minClimb) || minClimb < 0) {
      newErrors.push({ field: 'minClimb', message: 'עלייה מינימלית חייבת להיות 0 או יותר' });
    }
    if (isNaN(maxClimb) || maxClimb <= 0) {
      newErrors.push({ field: 'maxClimb', message: 'עלייה מקסימלית חייבת להיות גדולה מ-0' });
    }
    if (!isNaN(minClimb) && !isNaN(maxClimb) && minClimb > maxClimb) {
      newErrors.push({ field: 'minClimb', message: 'עלייה מינימלית לא יכולה להיות גדולה מהמקסימלית' });
    }

    setErrors(newErrors);
    return newErrors.length === 0;
  }, [generalDraft, missionDraft, climbDraft]);

  // Validate when draft values change
  useEffect(() => {
    if (isOpen) {
      validateAll();
    }
  }, [isOpen, generalDraft.safetyRadius, generalDraft.safetyHeight, generalDraft.outputHeight, validateAll]);

  const getFieldError = (field: string): string | undefined => {
    return errors.find(e => e.field === field)?.message;
  };

  const handleSave = useCallback(() => {
    if (!validateAll()) {
      return;
    }

    // Apply general settings
    setSafetyRadius(parseFloat(generalDraft.safetyRadius));
    setSafetyHeight(parseFloat(generalDraft.safetyHeight));
    setOutputHeight(parseFloat(generalDraft.outputHeight));

    // Apply mission settings
    setOverlapPercentage(parseFloat(missionDraft.overlapPercentage));
    setFovDegrees(parseFloat(missionDraft.fovDegrees));

    // Apply climb settings
    onSelectClimbPreset(selectedPresetId);
    setClimbConfig({
      climbRatio: parseFloat(climbDraft.climbRatio),
      descentRatio: parseFloat(climbDraft.descentRatio),
      allowTurnsDuringClimb: climbDraft.allowTurnsDuringClimb,
      linkRatios: climbDraft.linkRatios,
      vertexProximityMeters: parseFloat(climbDraft.vertexProximityMeters),
      minClimb: parseFloat(climbDraft.minClimb),
      maxClimb: parseFloat(climbDraft.maxClimb)
    });

    onClose();
  }, [validateAll, generalDraft, missionDraft, climbDraft, selectedPresetId, setSafetyRadius, setSafetyHeight, setOutputHeight, setOverlapPercentage, setFovDegrees, onSelectClimbPreset, setClimbConfig, onClose]);

  // Handle Enter key to save
  useEffect(() => {
    if (!isOpen) return;

    const handleEnter = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleSave();
      }
    };

    document.addEventListener('keydown', handleEnter);
    return () => {
      document.removeEventListener('keydown', handleEnter);
    };
  }, [isOpen, handleSave]);

  const handlePresetChange = useCallback((presetId: string) => {
    setSelectedPresetId(presetId);
    const preset = climbPresets.find(p => p.id === presetId);
    if (preset) {
      setClimbDraft(toDraft(preset));
    }
  }, [climbPresets]);

  const markCustomPreset = useCallback(() => {
    setSelectedPresetId('custom');
  }, []);

  const handleAllowTurnsChange = useCallback((checked: boolean) => {
    markCustomPreset();
    setClimbDraft(prev => ({ ...prev, allowTurnsDuringClimb: checked }));
  }, [markCustomPreset]);

  const selectedPreset = climbPresets.find(p => p.id === selectedPresetId);

  // Keyboard navigation for tabs
  const handleTabKeyDown = (e: React.KeyboardEvent, tabId: TabId) => {
    const tabs: TabId[] = ['general', 'mission', 'ascend-descend', 'shortcuts'];
    const currentIndex = tabs.indexOf(tabId);

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const direction = e.key === 'ArrowRight' ? -1 : 1; // RTL direction
      const newIndex = (currentIndex + direction + tabs.length) % tabs.length;
      setActiveTab(tabs[newIndex]);
    }
  };

  if (!isOpen) return null;

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    mouseDownTargetRef.current = e.target;
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    // Only close if both mousedown and click happened on the backdrop itself
    if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) {
      onClose();
    }
    mouseDownTargetRef.current = null;
  };

  return (
    <div
      className="settings-modal__backdrop"
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
    >
      <div
        className="settings-modal__card"
        ref={modalRef}
      >
        <div className="settings-modal__header">
          <h2 id="settings-modal-title" className="settings-modal__title">הגדרות</h2>
          <button
            className="settings-modal__close"
            onClick={onClose}
            aria-label="סגור"
            type="button"
          >
            ×
          </button>
        </div>

        <div className="settings-modal__tabs" role="tablist" aria-label="קטעי הגדרות">
          <button
            role="tab"
            aria-selected={activeTab === 'general'}
            aria-controls="tab-panel-general"
            id="tab-general"
            className={`settings-modal__tab ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
            onKeyDown={(e) => handleTabKeyDown(e, 'general')}
            tabIndex={activeTab === 'general' ? 0 : -1}
            type="button"
          >
            כללי
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'mission'}
            aria-controls="tab-panel-mission"
            id="tab-mission"
            className={`settings-modal__tab ${activeTab === 'mission' ? 'active' : ''}`}
            onClick={() => setActiveTab('mission')}
            onKeyDown={(e) => handleTabKeyDown(e, 'mission')}
            tabIndex={activeTab === 'mission' ? 0 : -1}
            type="button"
          >
            משימה
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'ascend-descend'}
            aria-controls="tab-panel-ascend-descend"
            id="tab-ascend-descend"
            className={`settings-modal__tab ${activeTab === 'ascend-descend' ? 'active' : ''}`}
            onClick={() => setActiveTab('ascend-descend')}
            onKeyDown={(e) => handleTabKeyDown(e, 'ascend-descend')}
            tabIndex={activeTab === 'ascend-descend' ? 0 : -1}
            type="button"
          >
            עלייה/ירידה
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'shortcuts'}
            aria-controls="tab-panel-shortcuts"
            id="tab-shortcuts"
            className={`settings-modal__tab ${activeTab === 'shortcuts' ? 'active' : ''}`}
            onClick={() => setActiveTab('shortcuts')}
            onKeyDown={(e) => handleTabKeyDown(e, 'shortcuts')}
            tabIndex={activeTab === 'shortcuts' ? 0 : -1}
            type="button"
          >
            מקשי קיצור
          </button>
        </div>

        <div className="settings-modal__body">
          {/* General Tab */}
          {activeTab === 'general' && (
            <div
              role="tabpanel"
              id="tab-panel-general"
              aria-labelledby="tab-general"
              className="settings-modal__panel"
            >
              <div className="settings-modal__field">
                <label htmlFor="safety-radius" className="settings-modal__label">
                  רדיוס בטיחות
                  <span className="settings-modal__unit">מטרים</span>
                </label>
                <input
                  ref={firstInputRef}
                  id="safety-radius"
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  required
                  inputMode="numeric"
                  aria-required="true"
                  value={generalDraft.safetyRadius}
                  onChange={(e) => {
                    setGeneralDraft(prev => ({ ...prev, safetyRadius: e.target.value }));
                    setTimeout(() => validateAll(), 0);
                  }}
                  className={`settings-modal__input ${getFieldError('safetyRadius') ? 'error' : ''}`}
                  aria-describedby={getFieldError('safetyRadius') ? 'safety-radius-error' : undefined}
                />
                {getFieldError('safetyRadius') && (
                  <span id="safety-radius-error" className="settings-modal__error" role="alert">
                    {getFieldError('safetyRadius')}
                  </span>
                )}
                <span className="settings-modal__hint">רדיוס החיפוש סביב קו המסלול לזיהוי מכשולים</span>
              </div>

              <div className="settings-modal__field">
                <label htmlFor="safety-height" className="settings-modal__label">
                  גובה בטיחות
                  <span className="settings-modal__unit">מטרים</span>
                </label>
                <input
                  id="safety-height"
                  type="number"
                  min="0"
                  max="1000"
                  step="0.1"
                  required
                  inputMode="decimal"
                  aria-required="true"
                  value={generalDraft.safetyHeight}
                  onChange={(e) => {
                    setGeneralDraft(prev => ({ ...prev, safetyHeight: e.target.value }));
                  }}
                  className={`settings-modal__input ${getFieldError('safetyHeight') ? 'error' : ''}`}
                  aria-describedby={getFieldError('safetyHeight') ? 'safety-height-error' : undefined}
                />
                {getFieldError('safetyHeight') && (
                  <span id="safety-height-error" className="settings-modal__error" role="alert">
                    {getFieldError('safetyHeight')}
                  </span>
                )}
                <span className="settings-modal__hint">גובה בטיחות מינימלי מעל מכשולים</span>
              </div>

              <div className="settings-modal__field">
                <label htmlFor="output-height" className="settings-modal__label">
                  גובה תוצר
                  <span className="settings-modal__unit">מטרים</span>
                </label>
                <input
                  id="output-height"
                  type="number"
                  min="0"
                  max="10000"
                  step="0.1"
                  required
                  inputMode="decimal"
                  aria-required="true"
                  value={generalDraft.outputHeight}
                  onChange={(e) => {
                    setGeneralDraft(prev => ({ ...prev, outputHeight: e.target.value }));
                    // Trigger validation to check dependencies
                    setTimeout(() => validateAll(), 0);
                  }}
                  className={`settings-modal__input ${getFieldError('outputHeight') ? 'error' : ''}`}
                  aria-describedby={getFieldError('outputHeight') ? 'output-height-error' : undefined}
                />
                {getFieldError('outputHeight') && (
                  <span id="output-height-error" className="settings-modal__error" role="alert">
                    {getFieldError('outputHeight')}
                  </span>
                )}
                <span className="settings-modal__hint">גובה מקסימלי מנקודה הכי נמוכה באזור הצי"ח</span>
              </div>
            </div>
          )}

          {/* Mission Tab */}
          {activeTab === 'mission' && (
            <div
              role="tabpanel"
              id="tab-panel-mission"
              aria-labelledby="tab-mission"
              className="settings-modal__panel"
            >
              <div className="settings-modal__field">
                <label htmlFor="overlap-percentage" className="settings-modal__label">
                  אחוז חפיפה נדרש
                  <span className="settings-modal__unit">%</span>
                </label>
                <div className="settings-modal__input-wrapper">
                  <input
                    ref={activeTab === 'mission' ? firstInputRef : undefined}
                    id="overlap-percentage"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    required
                    inputMode="numeric"
                    aria-required="true"
                    value={missionDraft.overlapPercentage}
                    onChange={(e) => {
                      setMissionDraft(prev => ({ ...prev, overlapPercentage: e.target.value }));
                      setTimeout(() => validateAll(), 0);
                    }}
                    className={`settings-modal__input ${getFieldError('overlapPercentage') ? 'error' : ''}`}
                    aria-describedby={getFieldError('overlapPercentage') ? 'overlap-error' : undefined}
                  />
                  <span className="settings-modal__suffix">%</span>
                </div>
                {getFieldError('overlapPercentage') && (
                  <span id="overlap-error" className="settings-modal__error" role="alert">
                    {getFieldError('overlapPercentage')}
                  </span>
                )}
                <span className="settings-modal__hint">אחוז החפיפה הנדרש בין סריקות סמוכות (0-100)</span>
              </div>

              <div className="settings-modal__field">
                <label htmlFor="fov-degrees" className="settings-modal__label">
                  מפתח סריקה (FOV)
                  <span className="settings-modal__unit">מעלות</span>
                </label>
                <div className="settings-modal__input-wrapper">
                  <input
                    id="fov-degrees"
                    type="number"
                    min="1"
                    max="179"
                    step="1"
                    required
                    inputMode="numeric"
                    aria-required="true"
                    value={missionDraft.fovDegrees}
                    onChange={(e) => {
                      setMissionDraft(prev => ({ ...prev, fovDegrees: e.target.value }));
                      setTimeout(() => validateAll(), 0);
                    }}
                    className={`settings-modal__input ${getFieldError('fovDegrees') ? 'error' : ''}`}
                    aria-describedby={getFieldError('fovDegrees') ? 'fov-error' : undefined}
                  />
                  <span className="settings-modal__suffix">°</span>
                </div>
                {getFieldError('fovDegrees') && (
                  <span id="fov-error" className="settings-modal__error" role="alert">
                    {getFieldError('fovDegrees')}
                  </span>
                )}
                <span className="settings-modal__hint">זווית שדה הראייה של חיישן ה-LiDAR</span>
              </div>
            </div>
          )}

          {/* Ascend/Descend Tab */}
          {activeTab === 'ascend-descend' && (
            <div
              role="tabpanel"
              id="tab-panel-ascend-descend"
              aria-labelledby="tab-ascend-descend"
              className="settings-modal__panel"
            >
              <div className="settings-modal__field">
                <label htmlFor="climb-preset" className="settings-modal__label">
                  תבנית מוגדרת
                </label>
                <select
                  ref={activeTab === 'ascend-descend' ? (firstInputRef as any) : undefined}
                  id="climb-preset"
                  value={selectedPresetId}
                  onChange={(e) => handlePresetChange(e.target.value)}
                  className="settings-modal__input settings-modal__select"
                >
                  <option value="custom">מותאם אישית (ערוך למטה)</option>
                  {climbPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                <span className="settings-modal__hint">
                  {selectedPresetId === 'custom'
                    ? 'ערוך את השדות למטה כדי להגדיר את התנהגות העלייה שלך.'
                    : selectedPreset?.description || 'תבנית נטענה מ-climbPresets.json.'}
                </span>
              </div>

              <div className="settings-modal__toggle-field">
                <label className="settings-modal__toggle">
                  <input
                    type="checkbox"
                    checked={climbDraft.linkRatios}
                    onChange={(e) => {
                      const linked = e.target.checked;
                      markCustomPreset();
                      setClimbDraft(prev => ({
                        ...prev,
                        linkRatios: linked,
                        descentRatio: linked ? prev.climbRatio : prev.descentRatio
                      }));
                    }}
                  />
                  <span className="settings-modal__toggle-slider"></span>
                  <span className="settings-modal__toggle-label">קשר יחסים (השתמש באותו ערך לעלייה וירידה)</span>
                </label>
              </div>

              <div className="settings-modal__row">
                <div className="settings-modal__field settings-modal__field--half">
                  <label htmlFor="climb-ratio" className="settings-modal__label">
                    יחס עלייה
                    <span className="settings-modal__unit">מ' אופקי / 1מ' אנכי</span>
                  </label>
                  <input
                    id="climb-ratio"
                    type="number"
                    step="0.01"
                    min="0.1"
                    max="100"
                    required
                    inputMode="decimal"
                    aria-required="true"
                    value={climbDraft.climbRatio}
                    onChange={(e) => {
                      markCustomPreset();
                      setClimbDraft(prev => ({
                        ...prev,
                        climbRatio: e.target.value,
                        descentRatio: prev.linkRatios ? e.target.value : prev.descentRatio
                      }));
                      setTimeout(() => validateAll(), 0);
                    }}
                    className={`settings-modal__input ${getFieldError('climbRatio') ? 'error' : ''}`}
                  />
                  {getFieldError('climbRatio') && (
                    <span className="settings-modal__error" role="alert">
                      {getFieldError('climbRatio')}
                    </span>
                  )}
                </div>

                <div className="settings-modal__field settings-modal__field--half">
                  <label htmlFor="descent-ratio" className="settings-modal__label">
                    יחס ירידה
                    <span className="settings-modal__unit">מ' אופקי / 1מ' אנכי</span>
                  </label>
                  <input
                    id="descent-ratio"
                    type="number"
                    step="0.01"
                    min="0.1"
                    max="100"
                    required
                    inputMode="decimal"
                    aria-required="true"
                    value={climbDraft.descentRatio}
                    onChange={(e) => {
                      markCustomPreset();
                      setClimbDraft(prev => ({ ...prev, descentRatio: e.target.value }));
                      setTimeout(() => validateAll(), 0);
                    }}
                    className={`settings-modal__input ${getFieldError('descentRatio') ? 'error' : ''}`}
                    disabled={climbDraft.linkRatios}
                  />
                  {getFieldError('descentRatio') && (
                    <span className="settings-modal__error" role="alert">
                      {getFieldError('descentRatio')}
                    </span>
                  )}
                </div>
              </div>

              <div className="settings-modal__field">
                <label htmlFor="vertex-proximity" className="settings-modal__label">
                  קרבת קודקוד
                  <span className="settings-modal__unit">מטרים</span>
                </label>
                <input
                  id="vertex-proximity"
                  type="number"
                  step="0.1"
                  min="0"
                  max="1000"
                  required
                  inputMode="decimal"
                  aria-required="true"
                  value={climbDraft.vertexProximityMeters}
                  onChange={(e) => {
                    markCustomPreset();
                    setClimbDraft(prev => ({ ...prev, vertexProximityMeters: e.target.value }));
                    setTimeout(() => validateAll(), 0);
                  }}
                  className={`settings-modal__input ${getFieldError('vertexProximityMeters') ? 'error' : ''}`}
                />
                {getFieldError('vertexProximityMeters') && (
                  <span className="settings-modal__error" role="alert">
                    {getFieldError('vertexProximityMeters')}
                  </span>
                )}
                <span className="settings-modal__hint">מרחק מקודקוד שבו העלייה נעצרת</span>
              </div>

              <div className="settings-modal__row">
                <div className="settings-modal__field settings-modal__field--half">
                  <label htmlFor="min-climb" className="settings-modal__label">
                    עליה/ירידה מינימלית
                    <span className="settings-modal__unit">מטרים</span>
                  </label>
                  <input
                    id="min-climb"
                    type="number"
                    step="0.1"
                    min="0"
                    max="1000"
                    required
                    inputMode="decimal"
                    aria-required="true"
                    value={climbDraft.minClimb}
                    onChange={(e) => {
                      markCustomPreset();
                      setClimbDraft(prev => ({ ...prev, minClimb: e.target.value }));
                      setTimeout(() => validateAll(), 0);
                    }}
                    className={`settings-modal__input ${getFieldError('minClimb') ? 'error' : ''}`}
                  />
                  {getFieldError('minClimb') && (
                    <span className="settings-modal__error" role="alert">
                      {getFieldError('minClimb')}
                    </span>
                  )}
                </div>

                <div className="settings-modal__field settings-modal__field--half">
                  <label htmlFor="max-climb" className="settings-modal__label">
                    עלייה מקסימלית
                    <span className="settings-modal__unit">מטרים</span>
                  </label>
                  <input
                    id="max-climb"
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="1000"
                    required
                    inputMode="decimal"
                    aria-required="true"
                    value={climbDraft.maxClimb}
                    onChange={(e) => {
                      markCustomPreset();
                      setClimbDraft(prev => ({ ...prev, maxClimb: e.target.value }));
                      setTimeout(() => validateAll(), 0);
                    }}
                    className={`settings-modal__input ${getFieldError('maxClimb') ? 'error' : ''}`}
                  />
                  {getFieldError('maxClimb') && (
                    <span className="settings-modal__error" role="alert">
                      {getFieldError('maxClimb')}
                    </span>
                  )}
                </div>
              </div>

              <div className="settings-modal__toggle-field">
                <label className="settings-modal__toggle">
                  <input
                    type="checkbox"
                    checked={climbDraft.allowTurnsDuringClimb}
                    onChange={(e) => handleAllowTurnsChange(e.target.checked)}
                  />
                  <span className="settings-modal__toggle-slider"></span>
                  <span className="settings-modal__toggle-label">אפשר עלייה דרך פניות (אחרת, העלייה נעצרת עד סוף הפנייה)</span>
                </label>
              </div>

              <div className="settings-modal__info-box">
                שינויים חלים מיד על עליות חדשות. עליות קיימות מחושבות מחדש עם המדיניות החדשה.
              </div>
            </div>
          )}

          {/* Keyboard Shortcuts Tab */}
          {activeTab === 'shortcuts' && (
            <div
              role="tabpanel"
              id="tab-panel-shortcuts"
              aria-labelledby="tab-shortcuts"
              className="settings-modal__panel"
            >
              {[
                {
                  category: 'מפה',
                  rows: [
                    { key: 'לחיצה כפולה עם לחצן ימני', action: 'הפעלת מצב שרטוט' },
                    { key: 'לחצן ימני / ESC', action: 'יציאה ממצב שרטוט' },
                    { key: 'Alt (בזמן גרירת נקודה)', action: 'עיגון כיוון הקו (ראשונה/אחרונה בלבד)' },
                    { key: 'Ctrl + לחיצה על נקודה', action: 'בחירה מרובה' },
                    { key: 'Delete / Backspace', action: 'מחיקת נקודות שנבחרו' },
                    { key: 'ESC (בזמן גרירה)', action: 'ביטול גרירה' },
                  ],
                },
                {
                  category: 'פרויקט',
                  rows: [
                    { key: 'Ctrl+S / Cmd+S', action: 'שמירת פרויקט' },
                  ],
                },
                {
                  category: 'תצוגה',
                  rows: [
                    { key: 'Ctrl+3 / Cmd+3', action: 'מחזור תצוגות תלת-ממד: כבוי ← מסך מלא ← חלון צף' },
                  ],
                },
                {
                  category: 'דיאלוגים',
                  rows: [
                    { key: 'Enter', action: 'אישור קלט' },
                    { key: 'ESC', action: 'סגירת חלון' },
                  ],
                },
              ].map(({ category, rows }) => (
                <div key={category} className="settings-modal__field">
                  <div className="settings-modal__label" style={{ marginBottom: '6px' }}>{category}</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {rows.map(({ key, action }) => (
                        <tr key={key} style={{ borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
                          <td style={{ padding: '6px 8px 6px 0', width: '55%', verticalAlign: 'middle' }}>
                            <kbd style={{
                              fontFamily: 'monospace',
                              background: '#f0f0f0',
                              border: '1px solid #ccc',
                              borderRadius: '3px',
                              padding: '1px 5px',
                              fontSize: '0.85em',
                              whiteSpace: 'nowrap',
                            }}>{key}</kbd>
                          </td>
                          <td style={{ padding: '6px 0', verticalAlign: 'middle', fontSize: '0.9em' }}>{action}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="settings-modal__footer">
          <button
            className="btn btn-secondary"
            onClick={onClose}
            type="button"
          >
            ביטול
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            type="button"
          >
            שמור
          </button>
        </div>
      </div>
    </div>
  );
};

// Export the gear icon for use in App.tsx
export { GearIcon };
export default SettingsModal;

