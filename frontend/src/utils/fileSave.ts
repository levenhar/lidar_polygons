/**
 * Save file using File System Access API if available, otherwise fall back to download
 * @param content File content as string or Blob
 * @param suggestedName Suggested filename
 * @param mimeType MIME type for the file
 * @returns Promise that resolves when file is saved
 */
export async function saveFileWithLocation(
  content: string | Blob,
  suggestedName: string,
  mimeType?: string
): Promise<void> {
  // Check if File System Access API is available
  if ('showSaveFilePicker' in window) {
    try {
      const fileHandle = await (window as any).showSaveFilePicker({
        suggestedName,
        types: mimeType ? [{
          description: suggestedName.split('.').pop()?.toUpperCase() || 'File',
          accept: {
            [mimeType || 'application/octet-stream']: [`.${suggestedName.split('.').pop() || ''}`]
          }
        }] : undefined
      });

      // Create a writable stream
      const writable = await fileHandle.createWritable();
      
      // Write the content
      if (typeof content === 'string') {
        await writable.write(content);
      } else {
        // For Blob, use arrayBuffer for binary files (like ZIP, TIFF), text for text files
        const isBinary = mimeType === 'application/zip' || 
                        mimeType?.includes('zip') ||
                        mimeType === 'image/tiff' ||
                        mimeType === 'image/geotiff' ||
                        mimeType?.startsWith('image/');
        if (isBinary) {
          // Binary file - use arrayBuffer
          const arrayBuffer = await content.arrayBuffer();
          await writable.write(arrayBuffer);
        } else {
          // Text file - use text
          const blobContent = await content.text();
          await writable.write(blobContent);
        }
      }
      
      // Close the file
      await writable.close();
      return;
    } catch (error: any) {
      // User cancelled the dialog or error occurred
      if (error.name === 'AbortError') {
        throw new Error('User cancelled file save');
      }
      // If there's an error with File System Access API, fall through to download
      console.warn('File System Access API failed, falling back to download:', error);
    }
  }

  // Fallback to download approach
  const blob = typeof content === 'string' 
    ? new Blob([content], { type: mimeType || 'application/octet-stream' })
    : content;
  
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Save file to a specific directory handle
 * @param directoryHandle Directory handle to save to
 * @param filename Filename
 * @param content File content
 */
async function saveFileToDirectoryHandle(
  directoryHandle: any,
  filename: string,
  content: string | Blob
): Promise<void> {
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  
  if (typeof content === 'string') {
    await writable.write(content);
  } else {
    const blobContent = await content.text();
    await writable.write(blobContent);
  }
  
  await writable.close();
}

/**
 * Save multiple files to a directory
 * @param directoryHandle Directory handle to save to
 * @param files Array of { content: string | Blob, filename: string }
 * @returns Object with savedCount and errors array
 */
export async function saveFilesToDirectoryHandle(
  directoryHandle: FileSystemDirectoryHandle,
  files: Array<{ content: string | Blob; filename: string }>
): Promise<{ savedCount: number; errors: Array<{ filename: string; error: string }> }> {
  let savedCount = 0;
  const errors: Array<{ filename: string; error: string }> = [];

  for (const file of files) {
    try {
      await saveFileToDirectoryHandle(directoryHandle, file.filename, file.content);
      savedCount++;
    } catch (fileError: any) {
      console.error(`Error saving file ${file.filename}:`, fileError);
      errors.push({
        filename: file.filename,
        error: fileError.message || 'Unknown error'
      });
    }
  }

  return { savedCount, errors };
}

/**
 * Save multiple files to a directory chosen by the user
 * Uses showDirectoryPicker to get folder, then saves all files automatically
 * @param files Array of { content: string | Blob, filename: string, mimeType?: string }
 * @param existingDirectoryHandle Optional: use this directory handle instead of prompting
 * @returns Promise that resolves with folder label and save results, or rejects if user cancels
 */
export async function saveMultipleFilesToDirectory(
  files: Array<{ content: string | Blob; filename: string; mimeType?: string }>,
  existingDirectoryHandle?: FileSystemDirectoryHandle
): Promise<{ folderLabel: string; savedCount: number; errors: Array<{ filename: string; error: string }> }> {
  // Check if File System Access API is available
  if (existingDirectoryHandle) {
    // Use provided directory handle
    try {
      const { getDirectoryLabel: getLabel } = await import('./directoryStorage');
      const folderLabel = await getLabel(existingDirectoryHandle);
      
      // Save all files to the directory
      const filesToSave = files.map(f => ({ content: f.content, filename: f.filename }));
      const result = await saveFilesToDirectoryHandle(existingDirectoryHandle, filesToSave);

      if (result.savedCount === 0) {
        throw new Error('No files were saved');
      }

      return {
        folderLabel,
        savedCount: result.savedCount,
        errors: result.errors
      };
    } catch (error: any) {
      // If using stored handle fails, fall through to prompt for new folder
      console.warn('Failed to use stored directory handle, will prompt for new folder:', error);
    }
  }

  // Try to use directory picker (may fail for system folders)
  if ('showDirectoryPicker' in window) {
    try {
      let directoryHandle: FileSystemDirectoryHandle;
      let folderLabel: string;

      // Try without mode first (more permissive, works with Desktop)
      try {
        directoryHandle = await (window as any).showDirectoryPicker();
      } catch (error1: any) {
        // If that fails, try with readwrite mode
        try {
          directoryHandle = await (window as any).showDirectoryPicker({
            mode: 'readwrite'
          });
        } catch (error2: any) {
          // Both failed - likely system folder restriction
          // Fall through to showSaveFilePicker approach
          throw new Error('Directory picker blocked - likely system folder restriction');
        }
      }

      // Request permission if needed
      // requestPermission may not be in TypeScript types but exists at runtime
      const handle = directoryHandle as any;
      if (handle.requestPermission) {
        try {
          const permissionStatus = await handle.requestPermission({ mode: 'readwrite' });
          if (permissionStatus === 'denied') {
            throw new Error('Permission to write to directory was denied');
          }
        } catch (permError: any) {
          // Some browsers don't require explicit permission
          console.warn('Permission request note:', permError);
        }
      }
      
      // Get directory label
      const { getDirectoryLabel: getLabel } = await import('./directoryStorage');
      folderLabel = await getLabel(directoryHandle);

      // Save all files to the directory
      const filesToSave = files.map(f => ({ content: f.content, filename: f.filename }));
      const result = await saveFilesToDirectoryHandle(directoryHandle, filesToSave);

      if (result.savedCount === 0) {
        throw new Error('No files were saved');
      }

      // Store directory handle for future use
      const { storeDirectoryHandle } = await import('./directoryStorage');
      await storeDirectoryHandle(directoryHandle, folderLabel);

      return {
        folderLabel,
        savedCount: result.savedCount,
        errors: result.errors
      };
    } catch (error: any) {
      // User cancelled the dialog
      if (error.name === 'AbortError' || error.message?.includes('cancelled')) {
        throw new Error('User cancelled directory selection');
      }
      
      // If directory picker failed (e.g., system folder restriction),
      // fall through to showSaveFilePicker approach which works with Desktop
      if (error.message?.includes('system') || 
          error.message?.includes('restricted') ||
          error.message?.includes('Directory picker blocked')) {
        console.warn('Directory picker blocked, using showSaveFilePicker fallback:', error);
        // Fall through to showSaveFilePicker approach below
      } else {
        // Other error - log and fall through
        console.error('Directory save error:', error);
        console.warn('Falling back to showSaveFilePicker approach');
      }
    }
  }

  // Fallback: Use showSaveFilePicker for each file (works with Desktop/Documents)
  // The browser will remember the folder location
  if ('showSaveFilePicker' in window) {
    try {
      let savedCount = 0;
      const errors: Array<{ filename: string; error: string }> = [];
      let folderLabel = 'Selected Folder';

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const fileHandle = await (window as any).showSaveFilePicker({
            suggestedName: file.filename,
            types: file.mimeType ? [{
              description: file.filename.split('.').pop()?.toUpperCase() || 'File',
              accept: {
                [file.mimeType || 'application/octet-stream']: [`.${file.filename.split('.').pop() || ''}`]
              }
            }] : undefined
          });

          const writable = await fileHandle.createWritable();
          if (typeof file.content === 'string') {
            await writable.write(file.content);
          } else {
            const blobContent = await file.content.text();
            await writable.write(blobContent);
          }
          await writable.close();
          savedCount++;

          // Get folder label from first file (if possible)
          if (i === 0) {
            try {
              const handle = fileHandle as any;
              if (handle.getParent) {
                const parentDir = await handle.getParent();
                const { getDirectoryLabel: getLabel } = await import('./directoryStorage');
                folderLabel = await getLabel(parentDir);
                // Try to store the directory handle for future use
                try {
                  const { storeDirectoryHandle } = await import('./directoryStorage');
                  await storeDirectoryHandle(parentDir, folderLabel);
                } catch (storeError) {
                  // Can't store, that's okay
                  console.warn('Could not store directory handle:', storeError);
                }
              }
            } catch (e) {
              // Can't get parent, use default label
            }
          }

          // Small delay between saves to ensure browser handles them properly
          if (i < files.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        } catch (fileError: any) {
          if (fileError.name === 'AbortError' || fileError.message?.includes('cancelled')) {
            // User cancelled - stop saving
            if (i === 0) {
              throw new Error('User cancelled directory selection');
            }
            break;
          }
          console.error(`Error saving file ${file.filename}:`, fileError);
          errors.push({
            filename: file.filename,
            error: fileError.message || 'Unknown error'
          });
        }
      }

      if (savedCount === 0) {
        throw new Error('No files were saved');
      }

      return {
        folderLabel,
        savedCount,
        errors
      };
    } catch (error: any) {
      // User cancelled
      if (error.name === 'AbortError' || error.message?.includes('cancelled') || error.message?.includes('User cancelled')) {
        throw new Error('User cancelled directory selection');
      }
      
      // Log and fall through to download fallback
      console.error('showSaveFilePicker approach failed:', error);
    }
  }

  // Fallback: save files one by one using download approach
  // Note: This doesn't let user choose location, but at least saves all files
  let savedCount = 0;
  const errors: Array<{ filename: string; error: string }> = [];

  for (const file of files) {
    try {
      const blob = typeof file.content === 'string' 
        ? new Blob([file.content], { type: file.mimeType || 'application/octet-stream' })
        : file.content;
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      savedCount++;
      
      // Small delay between downloads to ensure browser handles them properly
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error: any) {
      errors.push({
        filename: file.filename,
        error: error.message || 'Unknown error'
      });
    }
  }

  return {
    folderLabel: 'Downloads',
    savedCount,
    errors
  };
}

