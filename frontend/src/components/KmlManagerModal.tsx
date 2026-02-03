import React from 'react';
import './KmlManagerModal.css';

export type PointSymbol = 'square' | 'circle' | 'triangle' | 'star' | 'diamond' | 'cross';

export interface KmlImport {
  id: string;
  name: string;
  points: Array<{ lng: number; lat: number; label: string }>;
  polygons: Array<{ coordinates: [number, number][]; name?: string }>;
  importedAt: number; // timestamp
  color: string; // hex color for points and polygons
  symbol: PointSymbol; // symbol type for points
  visible: boolean; // visibility state
}

interface KmlManagerModalProps {
  isOpen: boolean;
  kmlImports: KmlImport[];
  onDelete: (id: string) => void;
  onColorChange: (id: string, color: string) => void;
  onSymbolChange: (id: string, symbol: PointSymbol) => void;
  onVisibilityToggle: (id: string) => void;
  onZoomToKml: (id: string) => void;
  onDeleteAll: () => void;
  onImport: () => void;
  onClose: () => void;
}

const SYMBOL_OPTIONS: { value: PointSymbol; label: string; icon: string }[] = [
  { value: 'square', label: 'ריבוע', icon: '■' },
  { value: 'circle', label: 'עיגול', icon: '●' },
  { value: 'triangle', label: 'משולש', icon: '▲' },
  { value: 'star', label: 'כוכב', icon: '★' },
  { value: 'diamond', label: 'יהלום', icon: '◆' },
  { value: 'cross', label: 'צלב', icon: '✚' }
];

const KmlManagerModal: React.FC<KmlManagerModalProps> = ({
  isOpen,
  kmlImports,
  onDelete,
  onColorChange,
  onSymbolChange,
  onVisibilityToggle,
  onZoomToKml,
  onDeleteAll,
  onImport,
  onClose
}) => {
  if (!isOpen) return null;

  const handleDelete = (id: string) => {
    if (window.confirm('האם אתה בטוח שברצונך למחוק את ה-KML הזה?')) {
      onDelete(id);
    }
  };

  const handleDeleteAll = () => {
    if (window.confirm('האם אתה בטוח שברצונך למחוק את כל קבצי ה-KML?')) {
      onDeleteAll();
    }
  };

  return (
    <div className="kml-manager-modal__backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="kml-manager-modal__card" onClick={(e) => e.stopPropagation()}>
        <div className="kml-manager-modal__header">
          <h2 className="kml-manager-modal__title">ניהול קבצי KML</h2>
          <div className="kml-manager-modal__header-actions">
            <button
              type="button"
              className="kml-manager-modal__import-btn"
              onClick={onImport}
              aria-label="ייבא KML"
              title="ייבא KML"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="kml-manager-modal__import-icon"
              >
                <path
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 16V4"
                />
                <path
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M7 8l5-4 5 4"
                />
                <path
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 20h16"
                />
              </svg>
            </button>
            {kmlImports.length > 0 && (
              <button
                type="button"
                className="kml-manager-modal__delete-all-btn"
                onClick={handleDeleteAll}
                aria-label="מחק הכל"
                title="מחק הכל"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="kml-manager-modal__trash-icon"
                >
                  <path
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 6h18"
                  />
                  <path
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8 6V4h8v2"
                  />
                  <path
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19 6l-1 14H6L5 6"
                  />
                  <path
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M10 11v6"
                  />
                  <path
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M14 11v6"
                  />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="kml-manager-modal__close"
              onClick={onClose}
              aria-label="סגור"
            >
              ×
            </button>
          </div>
        </div>

        <div className="kml-manager-modal__body">
          {kmlImports.length === 0 ? (
            <p className="kml-manager-modal__empty">אין קבצי KML מיובאים</p>
          ) : (
            <ul className="kml-manager-modal__list">
              {kmlImports.map((kml) => (
                <li 
                  key={kml.id} 
                  className="kml-manager-modal__item"
                  onDoubleClick={() => onZoomToKml(kml.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <div className="kml-manager-modal__item-content">
                    <div className="kml-manager-modal__item-name">
                      {kml.name.replace(/\.kml$/i, '')}
                      {(kml.points.length > 0 || kml.polygons.length > 0) && (
                        <span className="kml-manager-modal__item-stats-inline">
                          {kml.points.length > 0 && (
                            <span className="kml-manager-modal__stat">
                              {kml.points.length} נקודות
                            </span>
                          )}
                          {kml.polygons.length > 0 && (
                            <span className="kml-manager-modal__stat">
                              {kml.polygons.length} מצולעים
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    <div className="kml-manager-modal__item-actions">
                      <div className="kml-manager-modal__controls-group">
                      <div className="kml-manager-modal__color-picker-wrapper">
                        <input
                          type="color"
                          id={`color-${kml.id}`}
                          value={kml.color}
                          onChange={(e) => onColorChange(kml.id, e.target.value)}
                          className="kml-manager-modal__color-input"
                        />
                      </div>
                        {kml.points.length > 0 && (
                          <div className="kml-manager-modal__symbol-picker-wrapper">
                            <select
                              id={`symbol-${kml.id}`}
                              value={kml.symbol}
                              onChange={(e) => onSymbolChange(kml.id, e.target.value as PointSymbol)}
                              className="kml-manager-modal__symbol-select"
                            >
                              {SYMBOL_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.icon}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="kml-manager-modal__visibility-btn"
                        onClick={() => onVisibilityToggle(kml.id)}
                        aria-label={kml.visible ? 'הסתר' : 'הצג'}
                        title={kml.visible ? 'הסתר' : 'הצג'}
                      >
                        {kml.visible ? (
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                            className="kml-manager-modal__eye-icon"
                          >
                            <path
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
                            />
                            <circle
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              cx="12"
                              cy="12"
                              r="3"
                            />
                          </svg>
                        ) : (
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                            className="kml-manager-modal__eye-icon"
                          >
                            <path
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
                            />
                            <line
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              x1="1"
                              y1="1"
                              x2="23"
                              y2="23"
                            />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        className="kml-manager-modal__delete-btn"
                        onClick={() => handleDelete(kml.id)}
                        aria-label={`מחק ${kml.name}`}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                          className="kml-manager-modal__trash-icon"
                        >
                          <path
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M3 6h18"
                          />
                          <path
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M8 6V4h8v2"
                          />
                          <path
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M19 6l-1 14H6L5 6"
                          />
                          <path
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M10 11v6"
                          />
                          <path
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M14 11v6"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

      </div>
    </div>
  );
};

export default KmlManagerModal;


