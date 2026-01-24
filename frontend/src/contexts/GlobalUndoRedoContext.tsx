import React, { createContext, useContext, useCallback, useRef, useState, useMemo, useEffect } from 'react';

export type ActionType = 'map' | 'elevation' | 'combined';

export interface UndoableAction {
  id: number;
  type: ActionType;
  label?: string;
  undo: () => void;
  redo: () => void;
}

interface GlobalUndoRedoContextValue {
  registerAction: (type: ActionType, undo: () => void, redo: () => void, label?: string) => number;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  undoStack: UndoableAction[];
  redoStack: UndoableAction[];
  clearHistory: () => void;
  // Register a callback to be called before any undo/redo operation
  // Useful for flushing pending operations (like edit queues)
  setBeforeUndoRedoCallback: (callback: (() => void) | null) => void;
}

const GlobalUndoRedoContext = createContext<GlobalUndoRedoContextValue | null>(null);

export function useGlobalUndoRedo(): GlobalUndoRedoContextValue {
  const context = useContext(GlobalUndoRedoContext);
  if (!context) {
    throw new Error('useGlobalUndoRedo must be used within a GlobalUndoRedoProvider');
  }
  return context;
}

interface GlobalUndoRedoProviderProps {
  children: React.ReactNode;
}

export function GlobalUndoRedoProvider({ children }: GlobalUndoRedoProviderProps) {
  // Monotonically increasing sequence number for deterministic ordering
  const sequenceRef = useRef<number>(0);
  
  // Using refs for stacks to avoid unnecessary re-renders during batch operations
  // We'll use state to track versions for components that need to react to changes
  const undoStackRef = useRef<UndoableAction[]>([]);
  const redoStackRef = useRef<UndoableAction[]>([]);
  
  // Callback to be called before undo/redo (e.g., to flush pending operations)
  const beforeUndoRedoRef = useRef<(() => void) | null>(null);
  
  // Version counter to trigger re-renders when stacks change
  const [version, setVersion] = useState(0);
  
  // Max history size to prevent memory issues
  const MAX_HISTORY_SIZE = 100;
  
  const setBeforeUndoRedoCallback = useCallback((callback: (() => void) | null) => {
    beforeUndoRedoRef.current = callback;
  }, []);

  const registerAction = useCallback((
    type: ActionType,
    undoFn: () => void,
    redoFn: () => void,
    label?: string
  ): number => {
    const id = ++sequenceRef.current;
    
    const action: UndoableAction = {
      id,
      type,
      label,
      undo: undoFn,
      redo: redoFn,
    };
    
    // Clear redo stack when new action is registered (standard behavior)
    redoStackRef.current = [];
    
    // Add to undo stack
    undoStackRef.current.push(action);
    
    // Trim history if it exceeds max size
    if (undoStackRef.current.length > MAX_HISTORY_SIZE) {
      undoStackRef.current = undoStackRef.current.slice(-MAX_HISTORY_SIZE);
    }
    
    // Trigger re-render
    setVersion(v => v + 1);
    
    return id;
  }, []);

  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    
    // Call beforeUndoRedo callback if registered (e.g., to flush pending edit queue)
    if (beforeUndoRedoRef.current) {
      beforeUndoRedoRef.current();
    }
    
    const action = undoStackRef.current.pop()!;
    
    // Execute the undo function
    action.undo();
    
    // Push to redo stack
    redoStackRef.current.push(action);
    
    // Trigger re-render
    setVersion(v => v + 1);
  }, []);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    
    // Call beforeUndoRedo callback if registered (e.g., to flush pending edit queue)
    if (beforeUndoRedoRef.current) {
      beforeUndoRedoRef.current();
    }
    
    const action = redoStackRef.current.pop()!;
    
    // Execute the redo function
    action.redo();
    
    // Push back to undo stack
    undoStackRef.current.push(action);
    
    // Trigger re-render
    setVersion(v => v + 1);
  }, []);

  const clearHistory = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    setVersion(v => v + 1);
  }, []);

  // Compute canUndo/canRedo based on current version (will update when stacks change)
  const canUndo = useMemo(() => undoStackRef.current.length > 0, [version]);
  const canRedo = useMemo(() => redoStackRef.current.length > 0, [version]);
  
  // Expose stacks for debugging/UI (memoized based on version)
  const undoStack = useMemo(() => [...undoStackRef.current], [version]);
  const redoStack = useMemo(() => [...redoStackRef.current], [version]);

  // Setup global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if focus is in an editable field - if so, let browser handle native undo
      const activeElement = document.activeElement;
      if (activeElement) {
        const tagName = activeElement.tagName.toLowerCase();
        const isEditable = 
          tagName === 'input' || 
          tagName === 'textarea' || 
          (activeElement as HTMLElement).isContentEditable ||
          activeElement.getAttribute('contenteditable') === 'true';
        
        if (isEditable) {
          // Don't intercept - let browser handle native undo for text inputs
          return;
        }
      }

      // Check for Ctrl+Z (undo) or Ctrl+Y / Ctrl+Shift+Z (redo)
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifier = isMac ? e.metaKey : e.ctrlKey;
      
      if (modifier) {
        if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
          // Ctrl+Z or Cmd+Z: Undo
          e.preventDefault();
          e.stopPropagation();
          if (undoStackRef.current.length > 0) {
            undo();
          }
        } else if (
          e.key === 'y' || 
          e.key === 'Y' || 
          ((e.key === 'z' || e.key === 'Z') && e.shiftKey)
        ) {
          // Ctrl+Y or Ctrl+Shift+Z or Cmd+Shift+Z: Redo
          e.preventDefault();
          e.stopPropagation();
          if (redoStackRef.current.length > 0) {
            redo();
          }
        }
      }
    };

    // Use capture phase to intercept before other handlers
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [undo, redo]);

  const value = useMemo(() => ({
    registerAction,
    undo,
    redo,
    canUndo,
    canRedo,
    undoStack,
    redoStack,
    clearHistory,
    setBeforeUndoRedoCallback,
  }), [registerAction, undo, redo, canUndo, canRedo, undoStack, redoStack, clearHistory, setBeforeUndoRedoCallback]);

  return (
    <GlobalUndoRedoContext.Provider value={value}>
      {children}
    </GlobalUndoRedoContext.Provider>
  );
}

