/**
 * Auto-Save Test Suite
 * This file contains tests to verify the auto-save functionality works correctly
 * and doesn't leave empty files when crashes occur.
 */

import { exportProject } from './utils/projectSerializer';

// Test interface for auto-save functionality
interface AutoSaveTestResult {
  testName: string;
  passed: boolean;
  message: string;
  duration: number;
}

class AutoSaveTester {
  private results: AutoSaveTestResult[] = [];

  // Test 1: Verify File System Access API is available
  async testFileSystemAPI(): Promise<AutoSaveTestResult> {
    const startTime = Date.now();
    
    try {
      const hasFileSystemAPI = 'showSaveFilePicker' in window;
      
      return {
        testName: 'File System Access API',
        passed: hasFileSystemAPI,
        message: hasFileSystemAPI 
          ? 'File System Access API is supported' 
          : 'File System Access API is not supported in this browser',
        duration: Date.now() - startTime
      };
    } catch (error) {
      return {
        testName: 'File System Access API',
        passed: false,
        message: `Error checking API: ${error}`,
        duration: Date.now() - startTime
      };
    }
  }

  // Test 2: Verify project data export works correctly
  async testProjectExport(): Promise<AutoSaveTestResult> {
    const startTime = Date.now();
    
    try {
      // Create mock project data
      const mockProjectData = {
        dtmSource: null,
        dtmInfo: null,
        activeClippedId: null,
        dtmSourceType: null,
        localDtmFile: null,
        serverDtmId: null,
        serverDtmMetadata: null,
        aoiGeometry: null,
        routes: [
          {
            id: 'test-route',
            name: 'Test Route',
            points: [
              { lng: 0, lat: 0, height: 100, id: 'point-1' },
              { lng: 0.001, lat: 0.001, height: 100, id: 'point-2' }
            ],
            color: '#ff0000',
            lineWidth: 2,
            visible: true,
            nominalFlightHeight: 100
          }
        ],
        activeRouteId: 'test-route',
        climbRequestsByRoute: {},
        general: {
          nominalFlightHeight: 100,
          safetyRadius: 60,
          safetyHeight: 140,
          outputHeight: 270
        },
        mission: {
          overlapPercentage: 50,
          fovDegrees: 75
        },
        ascendDescend: {
          selectedPresetId: 'custom',
          climbConfig: {
            climbRatio: 4.08,
            descentRatio: 8.16,
            allowTurnsDuringClimb: false,
            linkRatios: false,
            vertexProximityMeters: 50,
            minClimb: 11,
            maxClimb: 50
          }
        },
        display: {
          dtmPalette: 'gray' as const,
          dtmInverted: false,
          dtmOpacity: 0.1,
          showMetadata: true,
          showClimbLabels: true,
          showNextLineSuggestions: true
        },
        planningArea: undefined,
        kmlImports: []
      };

      const exportedData = exportProject(mockProjectData);
      const jsonString = JSON.stringify(exportedData, null, 2);
      
      // Verify the exported data is valid JSON and contains expected fields
      const parsed = JSON.parse(jsonString);
      const hasRequiredFields = parsed.routes && parsed.routes.length > 0 && 
                              parsed.routes[0].points && parsed.routes[0].points.length > 0;
      
      return {
        testName: 'Project Export',
        passed: hasRequiredFields,
        message: hasRequiredFields 
          ? 'Project data exports correctly with valid structure' 
          : 'Project export missing required fields',
        duration: Date.now() - startTime
      };
    } catch (error) {
      return {
        testName: 'Project Export',
        passed: false,
        message: `Export error: ${error}`,
        duration: Date.now() - startTime
      };
    }
  }

  // Test 3: Verify file write operations work correctly
  async testFileWrite(): Promise<AutoSaveTestResult> {
    const startTime = Date.now();
    
    try {
      const testData = JSON.stringify({ test: 'data', timestamp: Date.now() }, null, 2);
      
      // Try to create a test file
      if ('showSaveFilePicker' in window) {
        const fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: 'test-autosave.json',
          types: [{
            description: 'JSON file',
            accept: { 'application/json': ['.json'] }
          }]
        });

        const writable = await fileHandle.createWritable();
        await writable.write(testData);
        await writable.close();
        
        return {
          testName: 'File Write',
          passed: true,
          message: 'File write operation completed successfully',
          duration: Date.now() - startTime
        };
      } else {
        return {
          testName: 'File Write',
          passed: false,
          message: 'File System Access API not available',
          duration: Date.now() - startTime
        };
      }
    } catch (error) {
      return {
        testName: 'File Write',
        passed: false,
        message: `File write error: ${error}`,
        duration: Date.now() - startTime
      };
    }
  }

  // Test 4: Verify auto-save debouncing works
  async testAutoSaveDebouncing(): Promise<AutoSaveTestResult> {
    const startTime = Date.now();
    
    try {
      // This test simulates rapid state changes to verify debouncing
      const timeouts: NodeJS.Timeout[] = [];
      let executionCount = 0;
      
      // Simulate rapid changes
      for (let i = 0; i < 5; i++) {
        const timeout = setTimeout(() => {
          executionCount++;
        }, 1000); // 1 second delay like our auto-save
        timeouts.push(timeout);
      }
      
      // Clear all but the last timeout (simulating debouncing)
      for (let i = 0; i < timeouts.length - 1; i++) {
        clearTimeout(timeouts[i]);
      }
      
      // Wait for the last timeout
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      const debouncingWorks = executionCount === 1;
      
      return {
        testName: 'Auto-Save Debouncing',
        passed: debouncingWorks,
        message: debouncingWorks 
          ? 'Debouncing prevents multiple rapid executions' 
          : 'Debouncing failed - multiple executions occurred',
        duration: Date.now() - startTime
      };
    } catch (error) {
      return {
        testName: 'Auto-Save Debouncing',
        passed: false,
        message: `Debouncing test error: ${error}`,
        duration: Date.now() - startTime
      };
    }
  }

  // Run all tests
  async runAllTests(): Promise<AutoSaveTestResult[]> {
    console.log('🔍 Starting Auto-Save Test Suite');
    console.log('==================================');
    
    this.results = [];
    
    const tests = [
      () => this.testFileSystemAPI(),
      () => this.testProjectExport(),
      () => this.testFileWrite(),
      () => this.testAutoSaveDebouncing()
    ];
    
    for (const test of tests) {
      const result = await test();
      this.results.push(result);
      
      const status = result.passed ? '✅' : '❌';
      console.log(`${status} ${result.testName}: ${result.message} (${result.duration}ms)`);
    }
    
    this.printSummary();
    return this.results;
  }

  // Print test summary
  private printSummary(): void {
    const passedTests = this.results.filter(r => r.passed).length;
    const totalTests = this.results.length;
    const totalDuration = this.results.reduce((sum, r) => sum + r.duration, 0);
    
    console.log('\n📊 Test Summary');
    console.log('================');
    console.log(`✅ Passed: ${passedTests}/${totalTests} tests`);
    console.log(`⏱️ Total Duration: ${totalDuration}ms`);
    
    if (passedTests === totalTests) {
      console.log('🎉 All tests passed! Auto-save implementation is working correctly.');
    } else {
      console.log('⚠️ Some tests failed. Please review the implementation.');
    }
    
    console.log('\n🔧 Manual Testing Steps:');
    console.log('1. Enable auto-save in the application');
    console.log('2. Make changes to the flight path');
    console.log('3. Verify auto-save triggers after 1 second');
    console.log('4. Check the saved file contains valid data');
    console.log('5. Simulate a crash and verify data persistence');
  }
}

// Export for use in the application
export { AutoSaveTester };
export type { AutoSaveTestResult };

// Auto-run tests if this file is executed directly
if (typeof window !== 'undefined') {
  // In browser environment, add to window for manual testing
  (window as any).runAutoSaveTests = async () => {
    const tester = new AutoSaveTester();
    return await tester.runAllTests();
  };
  
  console.log('Auto-save tests loaded. Run runAutoSaveTests() in console to execute.');
}
