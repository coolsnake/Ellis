#!/usr/bin/env python3
"""Install Solana platform tools using Python (avoids curl TLS issues)"""
import os
import sys
import subprocess
import shutil
from pathlib import Path

def find_solana_install():
    """Find solana-install binary"""
    # Check common locations
    common_paths = [
        Path.home() / ".local" / "share" / "solana" / "install" / "active_release" / "bin" / "solana-install",
        Path("/usr/local/bin/solana-install"),
        Path("/usr/bin/solana-install"),
    ]
    
    for path in common_paths:
        if path.exists() and os.access(path, os.X_OK):
            return str(path)
    
    # Try to find in PATH
    solana_install = shutil.which('solana-install')
    if solana_install:
        return solana_install
    
    return None

def install_platform_tools():
    """Install Solana platform tools"""
    print("=== Installing Solana Platform Tools ===")
    
    solana_install = find_solana_install()
    
    if not solana_install:
        print("ERROR: solana-install not found")
        print("\nInstall Solana CLI first:")
        print("  python3 -c \"import urllib.request; exec(urllib.request.urlopen('https://release.solana.com/stable/install').read())\"")
        print("\nOr if you have curl working:")
        print("  sh -c \"$(curl -sSfL https://release.solana.com/stable/install)\"")
        return False
    
    print(f"Found solana-install: {solana_install}")
    
    # Try to install platform tools
    versions_to_try = ["2.0.0", "stable"]
    
    for version in versions_to_try:
        try:
            print(f"\nAttempting to install platform tools version: {version}")
            result = subprocess.run(
                [solana_install, 'init', version],
                check=True,
                capture_output=True,
                text=True,
                timeout=300  # 5 minute timeout
            )
            print(result.stdout)
            if result.stderr:
                print(result.stderr)
            print("✓ Platform tools installed successfully")
            return True
        except subprocess.TimeoutExpired:
            print(f"✗ Installation timed out for version {version}")
            continue
        except subprocess.CalledProcessError as e:
            print(f"✗ Installation failed for version {version}: {e.stderr}")
            if version == versions_to_try[-1]:
                print("\nAll installation attempts failed.")
                return False
            continue
    
    return False

def verify_installation():
    """Verify platform tools are installed and accessible"""
    bin_dir = Path.home() / ".local" / "share" / "solana" / "install" / "active_release" / "bin"
    build_sbf = bin_dir / "cargo-build-sbf"
    
    if build_sbf.exists() and os.access(build_sbf, os.X_OK):
        try:
            result = subprocess.run(
                [str(build_sbf), '--version'],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                print(f"✓ Platform tools verified: {result.stdout.strip()}")
                return True
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
    
    print("⚠ Platform tools installed but not accessible")
    print(f"  Ensure PATH includes: {bin_dir}")
    return False

if __name__ == "__main__":
    if install_platform_tools():
        verify_installation()
        sys.exit(0)
    else:
        sys.exit(1)

