#!/usr/bin/env python3
"""Install Solana CLI and platform tools using Python (avoids curl TLS issues)"""
import os
import sys
import subprocess
import shutil
import tempfile
from pathlib import Path

def ensure_requests():
    """Ensure requests library is available (better TLS handling)"""
    try:
        import requests
        return True
    except ImportError:
        print("⚠ requests library not found. Installing for better TLS support...")
        try:
            subprocess.run(
                [sys.executable, '-m', 'pip', 'install', '--user', 'requests'],
                check=True,
                capture_output=True,
                timeout=60
            )
            # Reload to pick up newly installed module
            import importlib
            importlib.invalidate_caches()
            try:
                import requests
                print("✓ requests library installed")
                return True
            except ImportError:
                print("⚠ requests installation succeeded but import failed, using urllib fallback")
                return False
        except Exception as e:
            print(f"⚠ Failed to install requests: {e}")
            print("  Continuing with urllib fallback...")
            return False

def download_with_requests(url, dest_path):
    """Download using requests library (better TLS handling)"""
    try:
        import requests
        print(f"Downloading {url}...")
        response = requests.get(url, stream=True, verify=True, timeout=30)
        response.raise_for_status()
        with open(dest_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        print(f"✓ Downloaded to {dest_path}")
        return True
    except ImportError:
        # Fallback to urllib with SSL context workaround
        import urllib.request
        import ssl
        print(f"Downloading {url} (using urllib)...")
        try:
            # Create SSL context that's more permissive
            ctx = ssl.create_default_context()
            # Try with certifi if available
            try:
                import certifi
                ctx = ssl.create_default_context(cafile=certifi.where())
            except ImportError:
                pass
            
            with urllib.request.urlopen(url, context=ctx, timeout=30) as response:
                with open(dest_path, 'wb') as f:
                    shutil.copyfileobj(response, f)
            print(f"✓ Downloaded to {dest_path}")
            return True
        except Exception as e:
            print(f"✗ Download failed: {e}")
            return False
    except Exception as e:
        print(f"✗ Download failed: {e}")
        return False

def install_solana_cli():
    """Install Solana CLI using Python"""
    print("=== Installing Solana CLI ===")
    
    # Check if already installed
    solana_bin = Path.home() / ".local" / "share" / "solana" / "install" / "active_release" / "bin"
    if (solana_bin / "solana").exists() or shutil.which('solana'):
        print("✓ Solana CLI already installed")
        # Update PATH for this session
        os.environ['PATH'] = f"{solana_bin}:{os.environ.get('PATH', '')}"
        return True
    
    # Download installer script
    installer_url = "https://release.solana.com/stable/install"
    installer_path = Path(tempfile.gettempdir()) / "solana-install.sh"
    
    if not download_with_requests(installer_url, installer_path):
        print("ERROR: Failed to download Solana installer")
        print("\nTrying alternative: Install requests library for better TLS support:")
        print("  pip3 install --user requests")
        print("\nOr install Solana CLI manually:")
        print("  sh -c \"$(curl -sSfL https://release.solana.com/stable/install)\"")
        return False
    
    # Make executable and run
    os.chmod(installer_path, 0o755)
    try:
        print("Running Solana installer...")
        # Set environment to avoid curl TLS issues in the installer script
        env = os.environ.copy()
        env['PATH'] = f"{solana_bin}:{env.get('PATH', '')}"
        
        result = subprocess.run(
            ['bash', str(installer_path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=300,
            env=env
        )
        print(result.stdout)
        if result.stderr:
            print(result.stderr)
        
        # Update PATH after installation
        os.environ['PATH'] = f"{solana_bin}:{os.environ.get('PATH', '')}"
        
        # Verify installation
        if (solana_bin / "solana").exists() or shutil.which('solana'):
            print("✓ Solana CLI installed successfully")
            return True
        else:
            print("⚠ Solana CLI installer completed but binary not found")
            print(f"  Expected location: {solana_bin / 'solana'}")
            print("  You may need to restart your shell or run:")
            print(f"  export PATH=\"{solana_bin}:$PATH\"")
            return False
    except subprocess.CalledProcessError as e:
        print(f"✗ Installation failed: {e.stderr}")
        if e.stdout:
            print(f"stdout: {e.stdout}")
        return False
    except subprocess.TimeoutExpired:
        print("✗ Installation timed out")
        return False
    finally:
        # Clean up installer
        try:
            installer_path.unlink()
        except:
            pass

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
    
    # First ensure Solana CLI is installed
    if not install_solana_cli():
        return False
    
    # Update PATH to include Solana bin (in case it wasn't set)
    solana_bin = Path.home() / ".local" / "share" / "solana" / "install" / "active_release" / "bin"
    os.environ['PATH'] = f"{solana_bin}:{os.environ.get('PATH', '')}"
    
    # Wait a moment for PATH to propagate
    import time
    time.sleep(1)
    
    solana_install = find_solana_install()
    
    if not solana_install:
        print("ERROR: solana-install not found even after installing Solana CLI")
        print(f"Expected location: {solana_bin / 'solana-install'}")
        print(f"Current PATH: {os.environ.get('PATH', '')}")
        # Try one more time with explicit path
        explicit_path = solana_bin / "solana-install"
        if explicit_path.exists() and os.access(explicit_path, os.X_OK):
            solana_install = str(explicit_path)
            print(f"Found solana-install at explicit path: {solana_install}")
        else:
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
    # Try to ensure requests is available for better TLS handling
    ensure_requests()
    
    if install_platform_tools():
        verify_installation()
        sys.exit(0)
    else:
        sys.exit(1)

