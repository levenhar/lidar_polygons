import React, { useEffect, useRef } from 'react';
import './ContextMenu.css';

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onDelete: () => void;
  onEdit?: () => void;
  onSetHeight: () => void;
}

const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  onClose,
  onDelete,
  onEdit,
  onSetHeight
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    // Add event listeners after a short delay to avoid immediate closing
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('contextmenu', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    }, 10);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('contextmenu', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleMenuItemClick = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        left: `${x}px`,
        top: `${y}px`
      }}
    >
      <div
        className="context-menu-item"
        onClick={() => handleMenuItemClick(onDelete)}
      >
        Delete Point
      </div>
      {onEdit && (
        <div
          className="context-menu-item"
          onClick={() => handleMenuItemClick(onEdit)}
        >
          Edit / Move Point
        </div>
      )}
      <div
        className="context-menu-item"
        onClick={() => handleMenuItemClick(onSetHeight)}
      >
        Set Flight Height
      </div>
    </div>
  );
};

export default ContextMenu;

