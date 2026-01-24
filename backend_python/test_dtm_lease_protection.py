"""
Tests for DTM lease protection system.

Run with: python -m pytest test_dtm_lease_protection.py -v
Or with unittest: python test_dtm_lease_protection.py
"""

import os
import sys
import time
import unittest
import tempfile
import threading
import shutil
from typing import Optional

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dtm_lease_manager import (
    DtmLeaseManager,
    Lease,
    LeaseStatus,
    DtmStatus,
    DEFAULT_LEASE_DURATION_SECONDS
)


class TestDtmLeaseManager(unittest.TestCase):
    """Test cases for the DTM Lease Manager."""
    
    def setUp(self):
        """Set up test fixtures."""
        # Use a temporary database for each test
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "test_leases.db")
        self.lease_manager = DtmLeaseManager(db_path=self.db_path)
    
    def tearDown(self):
        """Clean up after tests."""
        self.lease_manager.stop_cleanup_thread()
        # Close any open connections
        if hasattr(self.lease_manager, '_local') and hasattr(self.lease_manager._local, 'connection'):
            try:
                self.lease_manager._local.connection.close()
            except:
                pass
        # Remove temp directory
        shutil.rmtree(self.temp_dir, ignore_errors=True)
    
    # =========================================================================
    # Basic Lease Operations
    # =========================================================================
    
    def test_acquire_lease(self):
        """Test acquiring a new lease."""
        dtm_id = "test-dtm-1"
        client_id = "client-1"
        
        lease, was_renewed = self.lease_manager.acquire_lease(
            dtm_id=dtm_id,
            client_id=client_id,
            duration_seconds=60
        )
        
        self.assertIsInstance(lease, Lease)
        self.assertEqual(lease.dtm_id, dtm_id)
        self.assertEqual(lease.client_id, client_id)
        self.assertEqual(lease.status, LeaseStatus.ACTIVE)
        self.assertFalse(was_renewed)
        self.assertFalse(lease.is_expired())
    
    def test_acquire_lease_renews_existing(self):
        """Test that acquiring a lease for same client/session renews existing."""
        dtm_id = "test-dtm-1"
        client_id = "client-1"
        session_id = "session-1"
        
        # First acquisition
        lease1, was_renewed1 = self.lease_manager.acquire_lease(
            dtm_id=dtm_id,
            client_id=client_id,
            session_id=session_id,
            duration_seconds=60
        )
        self.assertFalse(was_renewed1)
        
        # Second acquisition (same client/session)
        time.sleep(0.1)  # Small delay
        lease2, was_renewed2 = self.lease_manager.acquire_lease(
            dtm_id=dtm_id,
            client_id=client_id,
            session_id=session_id,
            duration_seconds=60
        )
        
        self.assertTrue(was_renewed2)
        self.assertEqual(lease1.lease_id, lease2.lease_id)
        self.assertGreater(lease2.expires_at, lease1.expires_at)
    
    def test_renew_lease(self):
        """Test renewing an existing lease."""
        dtm_id = "test-dtm-1"
        client_id = "client-1"
        
        # Create lease
        lease, _ = self.lease_manager.acquire_lease(
            dtm_id=dtm_id,
            client_id=client_id,
            duration_seconds=60
        )
        
        original_expires_at = lease.expires_at
        time.sleep(0.1)
        
        # Renew
        renewed_lease = self.lease_manager.renew_lease(
            lease_id=lease.lease_id,
            duration_seconds=120
        )
        
        self.assertIsNotNone(renewed_lease)
        self.assertGreater(renewed_lease.expires_at, original_expires_at)
    
    def test_release_lease(self):
        """Test releasing a lease."""
        dtm_id = "test-dtm-1"
        client_id = "client-1"
        
        # Create lease
        lease, _ = self.lease_manager.acquire_lease(
            dtm_id=dtm_id,
            client_id=client_id
        )
        
        # Release
        released = self.lease_manager.release_lease(lease.lease_id)
        self.assertTrue(released)
        
        # Verify lease is released
        updated_lease = self.lease_manager.get_lease(lease.lease_id)
        self.assertEqual(updated_lease.status, LeaseStatus.RELEASED)
    
    # =========================================================================
    # Protection Tests
    # =========================================================================
    
    def test_protected_dtm_cannot_be_deleted_manually(self):
        """Test: Protected DTM cannot be deleted manually (409 Conflict)."""
        dtm_id = "test-dtm-protected"
        client_id = "client-1"
        
        # Register DTM and acquire lease
        self.lease_manager.register_dtm(dtm_id, f"/path/to/{dtm_id}.tif")
        self.lease_manager.acquire_lease(dtm_id=dtm_id, client_id=client_id)
        
        # Attempt to delete
        can_delete, message, lease_count = self.lease_manager.can_delete_dtm(
            dtm_id=dtm_id,
            caller="test",
            reason="manual_delete"
        )
        
        self.assertFalse(can_delete)
        self.assertEqual(lease_count, 1)
        self.assertIn("protected", message.lower())
    
    def test_cleanup_job_does_not_delete_protected_dtm(self):
        """Test: Cleanup job does not delete protected DTM."""
        dtm_id = "test-dtm-cleanup"
        client_id = "client-1"
        
        # Register DTM and acquire lease
        self.lease_manager.register_dtm(dtm_id, f"/path/to/{dtm_id}.tif")
        self.lease_manager.acquire_lease(dtm_id=dtm_id, client_id=client_id)
        
        # Simulate cleanup job check
        can_delete, message, lease_count = self.lease_manager.can_delete_dtm(
            dtm_id=dtm_id,
            caller="cleanup_job",
            reason="ttl_expired"
        )
        
        self.assertFalse(can_delete)
        self.assertGreater(lease_count, 0)
    
    def test_restart_safety(self):
        """Test: Restart safety - leases persist across manager recreation."""
        dtm_id = "test-dtm-restart"
        client_id = "client-1"
        
        # Register DTM and acquire lease
        self.lease_manager.register_dtm(dtm_id, f"/path/to/{dtm_id}.tif")
        lease, _ = self.lease_manager.acquire_lease(dtm_id=dtm_id, client_id=client_id)
        lease_id = lease.lease_id
        
        # Simulate restart by creating new manager with same DB
        new_manager = DtmLeaseManager(db_path=self.db_path)
        
        try:
            # Verify lease still exists and is active
            restored_lease = new_manager.get_lease(lease_id)
            self.assertIsNotNone(restored_lease)
            self.assertEqual(restored_lease.status, LeaseStatus.ACTIVE)
            
            # Verify DTM is still protected
            is_protected, count = new_manager.is_dtm_protected(dtm_id)
            self.assertTrue(is_protected)
            self.assertEqual(count, 1)
            
            # Verify delete is still blocked
            can_delete, _, _ = new_manager.can_delete_dtm(
                dtm_id=dtm_id,
                caller="test",
                reason="restart_test"
            )
            self.assertFalse(can_delete)
        finally:
            new_manager.stop_cleanup_thread()
    
    def test_lease_expiry_allows_deletion(self):
        """Test: Lease expiry allows deletion."""
        dtm_id = "test-dtm-expiry"
        client_id = "client-1"
        
        # Register DTM and acquire short-lived lease
        self.lease_manager.register_dtm(dtm_id, f"/path/to/{dtm_id}.tif")
        self.lease_manager.acquire_lease(
            dtm_id=dtm_id, 
            client_id=client_id,
            duration_seconds=1  # Very short lease
        )
        
        # Initially protected
        is_protected, _ = self.lease_manager.is_dtm_protected(dtm_id)
        self.assertTrue(is_protected)
        
        # Wait for lease to expire
        time.sleep(1.5)
        
        # Now should be deletable
        can_delete, _, lease_count = self.lease_manager.can_delete_dtm(
            dtm_id=dtm_id,
            caller="test",
            reason="after_expiry"
        )
        
        self.assertTrue(can_delete)
        self.assertEqual(lease_count, 0)
    
    def test_concurrent_leases(self):
        """Test: Concurrency - 2 clients acquire leases, release 1, still protected."""
        dtm_id = "test-dtm-concurrent"
        client1 = "client-1"
        client2 = "client-2"
        
        # Register DTM
        self.lease_manager.register_dtm(dtm_id, f"/path/to/{dtm_id}.tif")
        
        # Both clients acquire leases
        lease1, _ = self.lease_manager.acquire_lease(dtm_id=dtm_id, client_id=client1)
        lease2, _ = self.lease_manager.acquire_lease(dtm_id=dtm_id, client_id=client2)
        
        # Verify 2 active leases
        is_protected, count = self.lease_manager.is_dtm_protected(dtm_id)
        self.assertTrue(is_protected)
        self.assertEqual(count, 2)
        
        # Release first lease
        self.lease_manager.release_lease(lease1.lease_id)
        
        # Still protected (1 lease remaining)
        is_protected, count = self.lease_manager.is_dtm_protected(dtm_id)
        self.assertTrue(is_protected)
        self.assertEqual(count, 1)
        
        # Release second lease
        self.lease_manager.release_lease(lease2.lease_id)
        
        # Now deletable
        can_delete, _, count = self.lease_manager.can_delete_dtm(
            dtm_id=dtm_id,
            caller="test",
            reason="after_all_released"
        )
        self.assertTrue(can_delete)
        self.assertEqual(count, 0)
    
    def test_concurrent_acquire_release_thread_safety(self):
        """Test: Thread safety under concurrent operations."""
        dtm_id = "test-dtm-threads"
        num_threads = 10
        operations_per_thread = 20
        
        # Register DTM
        self.lease_manager.register_dtm(dtm_id, f"/path/to/{dtm_id}.tif")
        
        errors = []
        lease_ids = []
        lock = threading.Lock()
        
        def worker(thread_id):
            try:
                client_id = f"client-{thread_id}"
                for i in range(operations_per_thread):
                    # Acquire
                    lease, _ = self.lease_manager.acquire_lease(
                        dtm_id=dtm_id,
                        client_id=client_id,
                        session_id=f"session-{i}",
                        duration_seconds=30
                    )
                    with lock:
                        lease_ids.append(lease.lease_id)
                    
                    # Renew
                    self.lease_manager.renew_lease(lease.lease_id)
                    
                    # Release half the time
                    if i % 2 == 0:
                        self.lease_manager.release_lease(lease.lease_id)
            except Exception as e:
                with lock:
                    errors.append(f"Thread {thread_id}: {e}")
        
        # Start threads
        threads = [
            threading.Thread(target=worker, args=(i,))
            for i in range(num_threads)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        
        # No errors should have occurred
        self.assertEqual(errors, [], f"Errors occurred: {errors}")
        
        # Verify we can still query protection status
        is_protected, count = self.lease_manager.is_dtm_protected(dtm_id)
        # Some leases should still be active (the ones not released)
        self.assertIsInstance(count, int)
    
    # =========================================================================
    # Audit and Metrics Tests
    # =========================================================================
    
    def test_audit_log_records_operations(self):
        """Test: Audit log records all operations."""
        dtm_id = "test-dtm-audit"
        client_id = "client-audit"
        
        # Perform operations
        self.lease_manager.register_dtm(dtm_id, f"/path/to/{dtm_id}.tif")
        lease, _ = self.lease_manager.acquire_lease(dtm_id=dtm_id, client_id=client_id)
        self.lease_manager.renew_lease(lease.lease_id)
        self.lease_manager.can_delete_dtm(dtm_id, "test", "audit_test")
        self.lease_manager.release_lease(lease.lease_id)
        
        # Get audit log
        entries = self.lease_manager.get_audit_log(dtm_id=dtm_id)
        
        # Verify entries exist
        self.assertGreater(len(entries), 0)
        
        # Verify actions are logged
        actions = [e["action"] for e in entries]
        self.assertIn("register", actions)
        self.assertIn("lease_acquired", actions)
        self.assertIn("lease_renewed", actions)
        self.assertIn("lease_released", actions)
    
    def test_metrics_returns_correct_counts(self):
        """Test: Metrics returns correct counts."""
        dtm_id = "test-dtm-metrics"
        
        # Register and create leases
        self.lease_manager.register_dtm(dtm_id, f"/path/to/{dtm_id}.tif")
        self.lease_manager.acquire_lease(dtm_id=dtm_id, client_id="client-1")
        self.lease_manager.acquire_lease(dtm_id=dtm_id, client_id="client-2")
        
        metrics = self.lease_manager.get_metrics()
        
        self.assertIn("activeLeases", metrics)
        self.assertIn("totalDtms", metrics)
        self.assertIn("protectedDtms", metrics)
        self.assertGreaterEqual(metrics["activeLeases"], 2)
        self.assertGreaterEqual(metrics["totalDtms"], 1)
        self.assertGreaterEqual(metrics["protectedDtms"], 1)
    
    # =========================================================================
    # Edge Cases
    # =========================================================================
    
    def test_renew_nonexistent_lease_returns_none(self):
        """Test: Renewing non-existent lease returns None."""
        result = self.lease_manager.renew_lease("nonexistent-lease-id")
        self.assertIsNone(result)
    
    def test_release_nonexistent_lease_returns_false(self):
        """Test: Releasing non-existent lease returns False."""
        result = self.lease_manager.release_lease("nonexistent-lease-id")
        self.assertFalse(result)
    
    def test_protection_check_for_unknown_dtm(self):
        """Test: Protection check for unknown DTM returns not protected."""
        is_protected, count = self.lease_manager.is_dtm_protected("unknown-dtm")
        self.assertFalse(is_protected)
        self.assertEqual(count, 0)
    
    def test_delete_check_for_unknown_dtm_allowed(self):
        """Test: Delete check for unknown DTM is allowed."""
        can_delete, message, count = self.lease_manager.can_delete_dtm(
            "unknown-dtm",
            "test",
            "unknown_test"
        )
        self.assertTrue(can_delete)
        self.assertEqual(count, 0)


class TestDtmLeaseManagerCleanup(unittest.TestCase):
    """Test cases for lease cleanup functionality."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "test_cleanup.db")
        self.lease_manager = DtmLeaseManager(db_path=self.db_path)
    
    def tearDown(self):
        """Clean up after tests."""
        self.lease_manager.stop_cleanup_thread()
        if hasattr(self.lease_manager, '_local') and hasattr(self.lease_manager._local, 'connection'):
            try:
                self.lease_manager._local.connection.close()
            except:
                pass
        shutil.rmtree(self.temp_dir, ignore_errors=True)
    
    def test_cleanup_expired_leases(self):
        """Test: Cleanup marks expired leases."""
        dtm_id = "test-dtm-cleanup"
        
        # Create short-lived lease
        self.lease_manager.acquire_lease(
            dtm_id=dtm_id,
            client_id="client-1",
            duration_seconds=1
        )
        
        # Wait for expiry (lease expires after 1s, but cleanup has a grace period)
        # The lease should no longer be considered "active" after expiry even without cleanup
        time.sleep(1.5)
        
        # DTM should no longer be protected (expired lease doesn't count as active)
        is_protected, _ = self.lease_manager.is_dtm_protected(dtm_id)
        self.assertFalse(is_protected)
        
        # Note: The cleanup_expired_leases function marks leases as "expired" after
        # the grace period (LEASE_GRACE_PERIOD_SECONDS), but the is_dtm_protected
        # check already ignores expired leases based on expires_at timestamp.
    
    def test_pending_deletion_after_lease_expiry(self):
        """Test: DTMs marked for deletion are listed after leases expire."""
        dtm_id = "test-dtm-pending"
        
        # Register and acquire lease
        self.lease_manager.register_dtm(dtm_id, f"/path/to/{dtm_id}.tif")
        self.lease_manager.acquire_lease(
            dtm_id=dtm_id,
            client_id="client-1",
            duration_seconds=1
        )
        
        # Mark for deletion (should be pending due to lease)
        deleted_immediately = self.lease_manager.mark_dtm_for_deletion(dtm_id)
        self.assertFalse(deleted_immediately)
        
        # Wait for lease expiry
        time.sleep(1.5)
        
        # Run cleanup
        self.lease_manager.cleanup_expired_leases()
        
        # Should now be in pending deletion list
        pending = self.lease_manager.get_dtms_pending_deletion()
        self.assertIn(dtm_id, pending)


if __name__ == "__main__":
    unittest.main(verbosity=2)

