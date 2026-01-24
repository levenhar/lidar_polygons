"""
DTM Lease Manager - Persistent lease-based protection for DTM files.

This module provides a robust protection mechanism ensuring DTMs actively in use
cannot be deleted under any circumstances:
- Not by manual delete endpoints
- Not by scheduled cleanup jobs
- Not after server restart/reset
- Not after server redeploy/reboot

Uses SQLite for persistence across restarts and atomic operations for concurrency safety.
"""

import os
import sqlite3
import uuid
import time
import threading
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any, Tuple
from contextlib import contextmanager
from dataclasses import dataclass, asdict
from enum import Enum

logger = logging.getLogger("dtm_lease_manager")

# Default lease duration in seconds (5 minutes)
DEFAULT_LEASE_DURATION_SECONDS = 300
# Grace period after lease expires before cleanup (30 seconds)
LEASE_GRACE_PERIOD_SECONDS = 30
# Background cleanup interval (60 seconds)
CLEANUP_INTERVAL_SECONDS = 60


class LeaseStatus(str, Enum):
    ACTIVE = "active"
    EXPIRED = "expired"
    RELEASED = "released"


class DtmStatus(str, Enum):
    AVAILABLE = "available"
    PROTECTED = "protected"
    DELETING = "deleting"
    DELETED = "deleted"


@dataclass
class Lease:
    """Represents a DTM lease."""
    lease_id: str
    dtm_id: str
    client_id: str
    session_id: Optional[str]
    created_at: float  # Unix timestamp
    expires_at: float  # Unix timestamp
    last_renewed_at: float  # Unix timestamp
    status: LeaseStatus

    def is_expired(self) -> bool:
        return time.time() > self.expires_at

    def to_dict(self) -> Dict[str, Any]:
        return {
            "leaseId": self.lease_id,
            "dtmId": self.dtm_id,
            "clientId": self.client_id,
            "sessionId": self.session_id,
            "createdAt": datetime.fromtimestamp(self.created_at).isoformat(),
            "expiresAt": datetime.fromtimestamp(self.expires_at).isoformat(),
            "lastRenewedAt": datetime.fromtimestamp(self.last_renewed_at).isoformat(),
            "status": self.status.value,
            "isExpired": self.is_expired(),
            "remainingSeconds": max(0, self.expires_at - time.time())
        }


@dataclass
class DtmRecord:
    """Represents a DTM record with protection status."""
    dtm_id: str
    storage_path: str
    status: DtmStatus
    created_at: float
    last_accessed_at: float
    active_lease_count: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "dtmId": self.dtm_id,
            "storagePath": self.storage_path,
            "status": self.status.value,
            "createdAt": datetime.fromtimestamp(self.created_at).isoformat(),
            "lastAccessedAt": datetime.fromtimestamp(self.last_accessed_at).isoformat(),
            "activeLeaseCount": self.active_lease_count,
            "isProtected": self.active_lease_count > 0
        }


class DtmLeaseManager:
    """
    Manages DTM leases with persistent SQLite storage.
    
    Thread-safe and supports concurrent access from multiple processes
    (when using WAL mode which is enabled by default).
    """

    def __init__(self, db_path: Optional[str] = None):
        """
        Initialize the lease manager.
        
        Args:
            db_path: Path to SQLite database file. If None, uses default location
                     in backend_python directory.
        """
        if db_path is None:
            backend_dir = os.path.dirname(os.path.abspath(__file__))
            db_path = os.path.join(backend_dir, "dtm_leases.db")
        
        self.db_path = db_path
        self._local = threading.local()
        self._lock = threading.RLock()
        self._cleanup_thread: Optional[threading.Thread] = None
        self._shutdown_event = threading.Event()
        
        # Initialize database
        self._init_db()
        logger.info(f"DTM Lease Manager initialized with database: {self.db_path}")

    def _get_connection(self) -> sqlite3.Connection:
        """Get a thread-local database connection."""
        if not hasattr(self._local, 'connection') or self._local.connection is None:
            conn = sqlite3.connect(
                self.db_path,
                timeout=30.0,  # Wait up to 30 seconds for locks
                isolation_level=None,  # Autocommit mode for explicit transaction control
                check_same_thread=False
            )
            conn.row_factory = sqlite3.Row
            # Enable WAL mode for better concurrency
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA busy_timeout=30000")
            self._local.connection = conn
        return self._local.connection

    @contextmanager
    def _transaction(self):
        """Context manager for database transactions with automatic rollback on error."""
        conn = self._get_connection()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

    def _init_db(self):
        """Initialize database schema."""
        conn = self._get_connection()
        
        # Start a transaction for schema creation
        conn.execute("BEGIN")
        
        try:
            # Create DTM records table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS dtm_records (
                    dtm_id TEXT PRIMARY KEY,
                    storage_path TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'available',
                    created_at REAL NOT NULL,
                    last_accessed_at REAL NOT NULL
                )
            """)
            
            # Create leases table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS dtm_leases (
                    lease_id TEXT PRIMARY KEY,
                    dtm_id TEXT NOT NULL,
                    client_id TEXT NOT NULL,
                    session_id TEXT,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    last_renewed_at REAL NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    FOREIGN KEY (dtm_id) REFERENCES dtm_records(dtm_id) ON DELETE CASCADE
                )
            """)
            
            # Create indexes for efficient queries
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_leases_dtm_id ON dtm_leases(dtm_id)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_leases_expires_at ON dtm_leases(expires_at)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_leases_status ON dtm_leases(status)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_leases_client_session 
                ON dtm_leases(client_id, session_id)
            """)
            
            # Create audit log table for observability
            conn.execute("""
                CREATE TABLE IF NOT EXISTS dtm_audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp REAL NOT NULL,
                    trace_id TEXT,
                    dtm_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    caller TEXT,
                    reason TEXT,
                    outcome TEXT NOT NULL,
                    details TEXT
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_audit_dtm_id ON dtm_audit_log(dtm_id)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON dtm_audit_log(timestamp)
            """)
            
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        
        logger.info("Database schema initialized")

    def _log_audit(
        self,
        dtm_id: str,
        action: str,
        outcome: str,
        caller: Optional[str] = None,
        reason: Optional[str] = None,
        trace_id: Optional[str] = None,
        details: Optional[str] = None
    ):
        """Log an audit entry for observability."""
        try:
            conn = self._get_connection()
            conn.execute(
                """
                INSERT INTO dtm_audit_log 
                (timestamp, trace_id, dtm_id, action, caller, reason, outcome, details)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (time.time(), trace_id, dtm_id, action, caller, reason, outcome, details)
            )
            logger.info(
                f"[{trace_id or 'no-trace'}] DTM audit: dtm_id={dtm_id}, "
                f"action={action}, outcome={outcome}, reason={reason}, caller={caller}"
            )
        except Exception as e:
            logger.error(f"Failed to write audit log: {e}")

    # =========================================================================
    # DTM Record Management
    # =========================================================================

    def register_dtm(
        self,
        dtm_id: str,
        storage_path: str,
        trace_id: Optional[str] = None
    ) -> DtmRecord:
        """
        Register a new DTM in the system.
        
        Called after upload is finalized to ensure atomic registration.
        """
        now = time.time()
        with self._transaction() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO dtm_records 
                (dtm_id, storage_path, status, created_at, last_accessed_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (dtm_id, storage_path, DtmStatus.AVAILABLE.value, now, now)
            )
        
        self._log_audit(
            dtm_id=dtm_id,
            action="register",
            outcome="success",
            trace_id=trace_id,
            details=f"storage_path={storage_path}"
        )
        
        return DtmRecord(
            dtm_id=dtm_id,
            storage_path=storage_path,
            status=DtmStatus.AVAILABLE,
            created_at=now,
            last_accessed_at=now,
            active_lease_count=0
        )

    def get_dtm_record(self, dtm_id: str) -> Optional[DtmRecord]:
        """Get DTM record by ID."""
        conn = self._get_connection()
        row = conn.execute(
            """
            SELECT r.*, 
                   (SELECT COUNT(*) FROM dtm_leases l 
                    WHERE l.dtm_id = r.dtm_id 
                    AND l.status = 'active' 
                    AND l.expires_at > ?) as active_lease_count
            FROM dtm_records r
            WHERE r.dtm_id = ?
            """,
            (time.time(), dtm_id)
        ).fetchone()
        
        if row is None:
            return None
        
        return DtmRecord(
            dtm_id=row["dtm_id"],
            storage_path=row["storage_path"],
            status=DtmStatus(row["status"]),
            created_at=row["created_at"],
            last_accessed_at=row["last_accessed_at"],
            active_lease_count=row["active_lease_count"]
        )

    def update_dtm_access(self, dtm_id: str):
        """Update last access time for a DTM."""
        conn = self._get_connection()
        conn.execute(
            "UPDATE dtm_records SET last_accessed_at = ? WHERE dtm_id = ?",
            (time.time(), dtm_id)
        )

    # =========================================================================
    # Lease Management
    # =========================================================================

    def acquire_lease(
        self,
        dtm_id: str,
        client_id: str,
        session_id: Optional[str] = None,
        duration_seconds: int = DEFAULT_LEASE_DURATION_SECONDS,
        trace_id: Optional[str] = None
    ) -> Tuple[Lease, bool]:
        """
        Acquire a lease for a DTM.
        
        If the client/session already has an active lease, it will be renewed instead.
        
        Args:
            dtm_id: The DTM identifier
            client_id: Client identifier (e.g., IP address, user ID)
            session_id: Optional session identifier
            duration_seconds: Lease duration in seconds
            trace_id: Optional trace ID for correlation
            
        Returns:
            Tuple of (Lease, was_renewed: bool)
        """
        now = time.time()
        expires_at = now + duration_seconds
        
        with self._transaction() as conn:
            # Check if client/session already has an active lease for this DTM
            existing = conn.execute(
                """
                SELECT * FROM dtm_leases
                WHERE dtm_id = ? AND client_id = ? AND session_id IS ?
                AND status = 'active' AND expires_at > ?
                """,
                (dtm_id, client_id, session_id, now)
            ).fetchone()
            
            if existing:
                # Renew existing lease
                conn.execute(
                    """
                    UPDATE dtm_leases 
                    SET expires_at = ?, last_renewed_at = ?
                    WHERE lease_id = ?
                    """,
                    (expires_at, now, existing["lease_id"])
                )
                
                lease = Lease(
                    lease_id=existing["lease_id"],
                    dtm_id=dtm_id,
                    client_id=client_id,
                    session_id=session_id,
                    created_at=existing["created_at"],
                    expires_at=expires_at,
                    last_renewed_at=now,
                    status=LeaseStatus.ACTIVE
                )
                
                self._log_audit(
                    dtm_id=dtm_id,
                    action="lease_renewed",
                    outcome="success",
                    caller=client_id,
                    trace_id=trace_id,
                    details=f"lease_id={lease.lease_id}, expires_at={expires_at}"
                )
                
                return lease, True
            
            # Create new lease
            lease_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO dtm_leases 
                (lease_id, dtm_id, client_id, session_id, created_at, expires_at, last_renewed_at, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (lease_id, dtm_id, client_id, session_id, now, expires_at, now, LeaseStatus.ACTIVE.value)
            )
            
            # Ensure DTM record exists (auto-register if accessed without explicit registration)
            conn.execute(
                """
                INSERT OR IGNORE INTO dtm_records 
                (dtm_id, storage_path, status, created_at, last_accessed_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (dtm_id, "", DtmStatus.AVAILABLE.value, now, now)
            )
            
            # Update last access time
            conn.execute(
                "UPDATE dtm_records SET last_accessed_at = ? WHERE dtm_id = ?",
                (now, dtm_id)
            )
        
        lease = Lease(
            lease_id=lease_id,
            dtm_id=dtm_id,
            client_id=client_id,
            session_id=session_id,
            created_at=now,
            expires_at=expires_at,
            last_renewed_at=now,
            status=LeaseStatus.ACTIVE
        )
        
        self._log_audit(
            dtm_id=dtm_id,
            action="lease_acquired",
            outcome="success",
            caller=client_id,
            trace_id=trace_id,
            details=f"lease_id={lease_id}, expires_at={expires_at}"
        )
        
        return lease, False

    def renew_lease(
        self,
        lease_id: str,
        duration_seconds: int = DEFAULT_LEASE_DURATION_SECONDS,
        trace_id: Optional[str] = None
    ) -> Optional[Lease]:
        """
        Renew an existing lease.
        
        Args:
            lease_id: The lease identifier
            duration_seconds: New lease duration from now
            trace_id: Optional trace ID for correlation
            
        Returns:
            Updated Lease or None if not found/expired
        """
        now = time.time()
        expires_at = now + duration_seconds
        
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT * FROM dtm_leases WHERE lease_id = ?",
                (lease_id,)
            ).fetchone()
            
            if row is None:
                logger.warning(f"Lease not found: {lease_id}")
                return None
            
            if row["status"] != LeaseStatus.ACTIVE.value:
                logger.warning(f"Lease not active: {lease_id}, status={row['status']}")
                return None
            
            conn.execute(
                """
                UPDATE dtm_leases 
                SET expires_at = ?, last_renewed_at = ?
                WHERE lease_id = ?
                """,
                (expires_at, now, lease_id)
            )
            
            # Update DTM access time
            conn.execute(
                "UPDATE dtm_records SET last_accessed_at = ? WHERE dtm_id = ?",
                (now, row["dtm_id"])
            )
        
        lease = Lease(
            lease_id=lease_id,
            dtm_id=row["dtm_id"],
            client_id=row["client_id"],
            session_id=row["session_id"],
            created_at=row["created_at"],
            expires_at=expires_at,
            last_renewed_at=now,
            status=LeaseStatus.ACTIVE
        )
        
        self._log_audit(
            dtm_id=row["dtm_id"],
            action="lease_renewed",
            outcome="success",
            caller=row["client_id"],
            trace_id=trace_id,
            details=f"lease_id={lease_id}, new_expires_at={expires_at}"
        )
        
        return lease

    def release_lease(
        self,
        lease_id: str,
        trace_id: Optional[str] = None
    ) -> bool:
        """
        Release a lease (best-effort cleanup).
        
        Args:
            lease_id: The lease identifier
            trace_id: Optional trace ID for correlation
            
        Returns:
            True if lease was released, False if not found
        """
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT * FROM dtm_leases WHERE lease_id = ?",
                (lease_id,)
            ).fetchone()
            
            if row is None:
                return False
            
            conn.execute(
                "UPDATE dtm_leases SET status = ? WHERE lease_id = ?",
                (LeaseStatus.RELEASED.value, lease_id)
            )
        
        self._log_audit(
            dtm_id=row["dtm_id"],
            action="lease_released",
            outcome="success",
            caller=row["client_id"],
            trace_id=trace_id,
            details=f"lease_id={lease_id}"
        )
        
        return True

    def get_lease(self, lease_id: str) -> Optional[Lease]:
        """Get lease by ID."""
        conn = self._get_connection()
        row = conn.execute(
            "SELECT * FROM dtm_leases WHERE lease_id = ?",
            (lease_id,)
        ).fetchone()
        
        if row is None:
            return None
        
        return Lease(
            lease_id=row["lease_id"],
            dtm_id=row["dtm_id"],
            client_id=row["client_id"],
            session_id=row["session_id"],
            created_at=row["created_at"],
            expires_at=row["expires_at"],
            last_renewed_at=row["last_renewed_at"],
            status=LeaseStatus(row["status"])
        )

    def get_active_leases_for_dtm(self, dtm_id: str) -> List[Lease]:
        """Get all active (non-expired) leases for a DTM."""
        conn = self._get_connection()
        now = time.time()
        rows = conn.execute(
            """
            SELECT * FROM dtm_leases
            WHERE dtm_id = ? AND status = 'active' AND expires_at > ?
            ORDER BY expires_at DESC
            """,
            (dtm_id, now)
        ).fetchall()
        
        return [
            Lease(
                lease_id=row["lease_id"],
                dtm_id=row["dtm_id"],
                client_id=row["client_id"],
                session_id=row["session_id"],
                created_at=row["created_at"],
                expires_at=row["expires_at"],
                last_renewed_at=row["last_renewed_at"],
                status=LeaseStatus(row["status"])
            )
            for row in rows
        ]

    def count_active_leases(self, dtm_id: str) -> int:
        """Count active leases for a DTM."""
        conn = self._get_connection()
        now = time.time()
        row = conn.execute(
            """
            SELECT COUNT(*) as count FROM dtm_leases
            WHERE dtm_id = ? AND status = 'active' AND expires_at > ?
            """,
            (dtm_id, now)
        ).fetchone()
        return row["count"] if row else 0

    # =========================================================================
    # Protection Checks
    # =========================================================================

    def is_dtm_protected(self, dtm_id: str) -> Tuple[bool, int]:
        """
        Check if a DTM is protected by active leases.
        
        Args:
            dtm_id: The DTM identifier
            
        Returns:
            Tuple of (is_protected: bool, active_lease_count: int)
        """
        count = self.count_active_leases(dtm_id)
        return count > 0, count

    def can_delete_dtm(
        self,
        dtm_id: str,
        trace_id: Optional[str] = None,
        caller: Optional[str] = None,
        reason: Optional[str] = None
    ) -> Tuple[bool, str, int]:
        """
        Check if a DTM can be deleted.
        
        Args:
            dtm_id: The DTM identifier
            trace_id: Optional trace ID for correlation
            caller: Who is attempting the deletion
            reason: Reason for deletion attempt
            
        Returns:
            Tuple of (can_delete: bool, message: str, active_lease_count: int)
        """
        is_protected, lease_count = self.is_dtm_protected(dtm_id)
        
        if is_protected:
            message = f"DTM {dtm_id} is protected by {lease_count} active lease(s)"
            self._log_audit(
                dtm_id=dtm_id,
                action="delete_attempt",
                outcome="blocked",
                caller=caller,
                reason=reason,
                trace_id=trace_id,
                details=f"active_leases={lease_count}"
            )
            return False, message, lease_count
        
        return True, "DTM can be deleted", 0

    def mark_dtm_for_deletion(
        self,
        dtm_id: str,
        trace_id: Optional[str] = None,
        caller: Optional[str] = None
    ) -> bool:
        """
        Mark a DTM for deletion (soft delete request).
        
        The DTM will be deleted once all leases expire.
        """
        with self._transaction() as conn:
            # Check protection first
            is_protected, lease_count = self.is_dtm_protected(dtm_id)
            
            if is_protected:
                # Mark as deleting (will be cleaned up when leases expire)
                conn.execute(
                    "UPDATE dtm_records SET status = ? WHERE dtm_id = ?",
                    (DtmStatus.DELETING.value, dtm_id)
                )
                self._log_audit(
                    dtm_id=dtm_id,
                    action="mark_for_deletion",
                    outcome="pending",
                    caller=caller,
                    trace_id=trace_id,
                    details=f"active_leases={lease_count}, will delete when leases expire"
                )
                return False
            else:
                conn.execute(
                    "UPDATE dtm_records SET status = ? WHERE dtm_id = ?",
                    (DtmStatus.DELETED.value, dtm_id)
                )
                self._log_audit(
                    dtm_id=dtm_id,
                    action="mark_for_deletion",
                    outcome="success",
                    caller=caller,
                    trace_id=trace_id
                )
                return True

    def confirm_dtm_deleted(
        self,
        dtm_id: str,
        trace_id: Optional[str] = None,
        caller: Optional[str] = None
    ):
        """Confirm a DTM has been physically deleted."""
        with self._transaction() as conn:
            conn.execute(
                "UPDATE dtm_records SET status = ? WHERE dtm_id = ?",
                (DtmStatus.DELETED.value, dtm_id)
            )
            # Clean up leases for deleted DTM
            conn.execute(
                "DELETE FROM dtm_leases WHERE dtm_id = ?",
                (dtm_id,)
            )
        
        self._log_audit(
            dtm_id=dtm_id,
            action="deleted",
            outcome="success",
            caller=caller,
            trace_id=trace_id
        )

    # =========================================================================
    # Cleanup and Maintenance
    # =========================================================================

    def cleanup_expired_leases(self) -> int:
        """
        Clean up expired leases.
        
        Returns:
            Number of leases cleaned up
        """
        now = time.time()
        grace_time = now - LEASE_GRACE_PERIOD_SECONDS
        
        with self._transaction() as conn:
            # Mark expired leases
            result = conn.execute(
                """
                UPDATE dtm_leases 
                SET status = ?
                WHERE status = 'active' AND expires_at < ?
                """,
                (LeaseStatus.EXPIRED.value, grace_time)
            )
            expired_count = result.rowcount
            
            # Find DTMs marked for deletion with no active leases
            pending_deletions = conn.execute(
                """
                SELECT dtm_id FROM dtm_records
                WHERE status = 'deleting'
                AND NOT EXISTS (
                    SELECT 1 FROM dtm_leases
                    WHERE dtm_leases.dtm_id = dtm_records.dtm_id
                    AND status = 'active' AND expires_at > ?
                )
                """,
                (now,)
            ).fetchall()
            
            for row in pending_deletions:
                logger.info(f"DTM {row['dtm_id']} is ready for deletion (all leases expired)")
        
        if expired_count > 0:
            logger.info(f"Cleaned up {expired_count} expired leases")
        
        return expired_count

    def get_dtms_pending_deletion(self) -> List[str]:
        """Get list of DTMs marked for deletion with no active leases."""
        conn = self._get_connection()
        now = time.time()
        
        rows = conn.execute(
            """
            SELECT dtm_id FROM dtm_records
            WHERE status = 'deleting'
            AND NOT EXISTS (
                SELECT 1 FROM dtm_leases
                WHERE dtm_leases.dtm_id = dtm_records.dtm_id
                AND status = 'active' AND expires_at > ?
            )
            """,
            (now,)
        ).fetchall()
        
        return [row["dtm_id"] for row in rows]

    def start_cleanup_thread(self):
        """Start background thread for periodic lease cleanup."""
        if self._cleanup_thread is not None and self._cleanup_thread.is_alive():
            return
        
        self._shutdown_event.clear()
        self._cleanup_thread = threading.Thread(
            target=self._cleanup_loop,
            daemon=True,
            name="dtm-lease-cleanup"
        )
        self._cleanup_thread.start()
        logger.info("Started lease cleanup background thread")

    def stop_cleanup_thread(self):
        """Stop the background cleanup thread."""
        self._shutdown_event.set()
        if self._cleanup_thread is not None:
            self._cleanup_thread.join(timeout=5.0)
            self._cleanup_thread = None
        logger.info("Stopped lease cleanup background thread")

    def _cleanup_loop(self):
        """Background loop for periodic cleanup."""
        while not self._shutdown_event.is_set():
            try:
                self.cleanup_expired_leases()
            except Exception as e:
                logger.error(f"Error in cleanup loop: {e}", exc_info=True)
            
            # Wait for next interval or shutdown
            self._shutdown_event.wait(timeout=CLEANUP_INTERVAL_SECONDS)

    # =========================================================================
    # Metrics and Observability
    # =========================================================================

    def get_metrics(self) -> Dict[str, Any]:
        """Get metrics for monitoring."""
        conn = self._get_connection()
        now = time.time()
        
        # Active leases count
        active_leases = conn.execute(
            "SELECT COUNT(*) as count FROM dtm_leases WHERE status = 'active' AND expires_at > ?",
            (now,)
        ).fetchone()["count"]
        
        # Total DTMs
        total_dtms = conn.execute(
            "SELECT COUNT(*) as count FROM dtm_records"
        ).fetchone()["count"]
        
        # Protected DTMs
        protected_dtms = conn.execute(
            """
            SELECT COUNT(DISTINCT dtm_id) as count FROM dtm_leases 
            WHERE status = 'active' AND expires_at > ?
            """,
            (now,)
        ).fetchone()["count"]
        
        # Pending deletions
        pending_deletions = conn.execute(
            "SELECT COUNT(*) as count FROM dtm_records WHERE status = 'deleting'"
        ).fetchone()["count"]
        
        # Recent audit log counts (last hour)
        hour_ago = now - 3600
        audit_counts = {}
        for row in conn.execute(
            """
            SELECT action, outcome, COUNT(*) as count 
            FROM dtm_audit_log 
            WHERE timestamp > ?
            GROUP BY action, outcome
            """,
            (hour_ago,)
        ).fetchall():
            key = f"{row['action']}_{row['outcome']}"
            audit_counts[key] = row["count"]
        
        return {
            "activeLeases": active_leases,
            "totalDtms": total_dtms,
            "protectedDtms": protected_dtms,
            "pendingDeletions": pending_deletions,
            "auditCountsLastHour": audit_counts
        }

    def get_audit_log(
        self,
        dtm_id: Optional[str] = None,
        limit: int = 100,
        since_timestamp: Optional[float] = None
    ) -> List[Dict[str, Any]]:
        """Get audit log entries."""
        conn = self._get_connection()
        
        query = "SELECT * FROM dtm_audit_log WHERE 1=1"
        params: List[Any] = []
        
        if dtm_id:
            query += " AND dtm_id = ?"
            params.append(dtm_id)
        
        if since_timestamp:
            query += " AND timestamp > ?"
            params.append(since_timestamp)
        
        query += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)
        
        rows = conn.execute(query, params).fetchall()
        
        return [
            {
                "id": row["id"],
                "timestamp": datetime.fromtimestamp(row["timestamp"]).isoformat(),
                "traceId": row["trace_id"],
                "dtmId": row["dtm_id"],
                "action": row["action"],
                "caller": row["caller"],
                "reason": row["reason"],
                "outcome": row["outcome"],
                "details": row["details"]
            }
            for row in rows
        ]


# Global singleton instance
_lease_manager: Optional[DtmLeaseManager] = None
_lease_manager_lock = threading.Lock()


def get_lease_manager() -> DtmLeaseManager:
    """Get the global lease manager instance."""
    global _lease_manager
    if _lease_manager is None:
        with _lease_manager_lock:
            if _lease_manager is None:
                _lease_manager = DtmLeaseManager()
                _lease_manager.start_cleanup_thread()
    return _lease_manager


def shutdown_lease_manager():
    """Shutdown the global lease manager."""
    global _lease_manager
    if _lease_manager is not None:
        _lease_manager.stop_cleanup_thread()
        _lease_manager = None

