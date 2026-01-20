import React, { useState, useEffect, useRef } from 'react';
import { FlightRoute } from '../hooks/useFlightPath';
import './ExportSettingsModal.css';

interface ExportSettingsModalProps {
  isOpen: boolean;
  routes: FlightRoute[];
  activeRouteId: string;
  onClose: () => void;
  onExport: (selectedRouteIds: string[]) => void;
}

const ExportSettingsModal: React.FC<ExportSettingsModalProps> = ({
  isOpen,
  routes,
  activeRouteId,
  onClose,
  onExport
}) => {
  const [selectedRouteIds, setSelectedRouteIds] = useState<Set<string>>(new Set());
  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);

  // Calculate routes with points (used in multiple places)
  const routesWithPoints = routes.filter(route => route.points.length >= 2);
  const allSelected = routesWithPoints.length > 0 && 
    routesWithPoints.every(route => selectedRouteIds.has(route.id));
  const someSelected = routesWithPoints.some(route => selectedRouteIds.has(route.id));

  // Initialize with routes that have 2+ points
  useEffect(() => {
    if (isOpen) {
      const routesWithPointsForInit = routes.filter(route => route.points.length >= 2);
      if (routesWithPointsForInit.length > 0) {
        // Default: select active route if it has 2+ points, otherwise select all routes with points
        const activeRoute = routes.find(r => r.id === activeRouteId);
        if (activeRoute && activeRoute.points.length >= 2) {
          setSelectedRouteIds(new Set([activeRouteId]));
        } else {
          setSelectedRouteIds(new Set(routesWithPointsForInit.map(r => r.id)));
        }
      } else {
        setSelectedRouteIds(new Set());
      }
      
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
  }, [isOpen, routes, activeRouteId]);

  // Set indeterminate state on select all checkbox
  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = someSelected && !allSelected;
    }
  }, [someSelected, allSelected]);

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

  const handleToggleAll = () => {
    if (allSelected) {
      setSelectedRouteIds(new Set());
    } else {
      setSelectedRouteIds(new Set(routesWithPoints.map(r => r.id)));
    }
  };

  const handleToggleRoute = (routeId: string) => {
    const newSelected = new Set(selectedRouteIds);
    if (newSelected.has(routeId)) {
      newSelected.delete(routeId);
    } else {
      newSelected.add(routeId);
    }
    setSelectedRouteIds(newSelected);
  };

  const handleExport = () => {
    if (selectedRouteIds.size === 0) {
      alert('אנא בחר לפחות מסלול אחד לייצוא');
      return;
    }
    onExport(Array.from(selectedRouteIds));
    onClose();
  };

  const handleCancel = () => {
    onClose();
  };

  return (
    <div className="export-modal-overlay" onClick={handleCancel}>
      <div className="export-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="export-modal-header">
          <h2>הגדרות ייצוא</h2>
          <button className="export-modal-close" onClick={handleCancel}>
            ×
          </button>
        </div>
        
        <div className="export-modal-body">
          <p className="export-modal-description">
            בחר את המסלולים שברצונך לייצא:
          </p>
          
          {routesWithPoints.length === 0 ? (
            <p className="export-modal-empty">
              אין מסלולים עם לפחות 2 נקודות לייצוא
            </p>
          ) : (
            <>
              <div className="export-modal-select-all">
                <label className="export-modal-checkbox-label">
                  <input
                    type="checkbox"
                    ref={selectAllCheckboxRef}
                    checked={allSelected}
                    onChange={handleToggleAll}
                  />
                  <span>בחר הכל ({routesWithPoints.length} מסלולים)</span>
                </label>
              </div>
              
              <div className="export-modal-routes-list">
                {routesWithPoints.map((route) => (
                  <label
                    key={route.id}
                    className={`export-modal-route-item ${route.id === activeRouteId ? 'active' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedRouteIds.has(route.id)}
                      onChange={() => handleToggleRoute(route.id)}
                    />
                    <div className="export-modal-route-info">
                      <span className="export-modal-route-name">{route.name}</span>
                      {route.id === activeRouteId && (
                        <span className="export-modal-route-details">
                          <span className="export-modal-active-badge">פעיל</span>
                        </span>
                      )}
                    </div>
                    <div
                      className="export-modal-route-color"
                      style={{ backgroundColor: route.color }}
                    />
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        
        <div className="export-modal-footer">
          <button className="btn btn-secondary" onClick={handleCancel}>
            ביטול
          </button>
          <button
            className="btn btn-primary"
            onClick={handleExport}
            disabled={selectedRouteIds.size === 0}
          >
            ייצא ({selectedRouteIds.size})
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExportSettingsModal;

