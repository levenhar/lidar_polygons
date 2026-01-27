#!/usr/bin/env python3
"""
Initialize/Migrate the DTM lease database.

This script creates the necessary tables and indexes for the DTM lease
protection system. It's safe to run multiple times - it uses CREATE IF NOT EXISTS.

Usage:
    python init_lease_db.py [--db-path /path/to/db] [--verify]
"""

import argparse
import os
import sys
import sqlite3
from datetime import datetime


def get_default_db_path():
    """Get the default database path."""
    backend_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(backend_dir, "dtm_leases.db")


def init_database(db_path: str, verify: bool = False):
    """Initialize the lease database."""
    print(f"Initializing lease database at: {db_path}")
    
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    
    # Enable WAL mode for better concurrency
    conn.execute("PRAGMA journal_mode=WAL")
    
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
    print("  ✓ Created/verified dtm_records table")
    
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
    print("  ✓ Created/verified dtm_leases table")
    
    # Create indexes
    indexes = [
        ("idx_leases_dtm_id", "dtm_leases(dtm_id)"),
        ("idx_leases_expires_at", "dtm_leases(expires_at)"),
        ("idx_leases_status", "dtm_leases(status)"),
        ("idx_leases_client_session", "dtm_leases(client_id, session_id)"),
    ]
    
    for idx_name, idx_cols in indexes:
        conn.execute(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {idx_cols}")
        print(f"  ✓ Created/verified index: {idx_name}")
    
    # Create audit log table
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
    print("  ✓ Created/verified dtm_audit_log table")
    
    # Create audit log indexes
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_dtm_id ON dtm_audit_log(dtm_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON dtm_audit_log(timestamp)")
    print("  ✓ Created/verified audit log indexes")
    
    conn.commit()
    
    if verify:
        print("\nVerifying database structure...")
        
        # Check tables
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        print(f"  Tables: {[t['name'] for t in tables]}")
        
        # Check indexes
        indexes = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
        ).fetchall()
        print(f"  Indexes: {[i['name'] for i in indexes if not i['name'].startswith('sqlite_')]}")
        
        # Show record counts
        dtm_count = conn.execute("SELECT COUNT(*) FROM dtm_records").fetchone()[0]
        lease_count = conn.execute("SELECT COUNT(*) FROM dtm_leases").fetchone()[0]
        active_lease_count = conn.execute(
            "SELECT COUNT(*) FROM dtm_leases WHERE status = 'active' AND expires_at > ?",
            (datetime.now().timestamp(),)
        ).fetchone()[0]
        audit_count = conn.execute("SELECT COUNT(*) FROM dtm_audit_log").fetchone()[0]
        
        print(f"\n  Statistics:")
        print(f"    - DTM records: {dtm_count}")
        print(f"    - Total leases: {lease_count}")
        print(f"    - Active leases: {active_lease_count}")
        print(f"    - Audit log entries: {audit_count}")
    
    conn.close()
    print("\n✓ Database initialization complete!")


def main():
    parser = argparse.ArgumentParser(
        description="Initialize/Migrate the DTM lease database"
    )
    parser.add_argument(
        "--db-path",
        default=None,
        help="Path to the SQLite database file (default: dtm_leases.db in backend_python)"
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify database structure and show statistics after initialization"
    )
    
    args = parser.parse_args()
    
    db_path = args.db_path or get_default_db_path()
    init_database(db_path, verify=args.verify)


if __name__ == "__main__":
    main()


