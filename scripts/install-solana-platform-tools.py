#!/usr/bin/env python3
"""Install Solana CLI and platform tools using Python (avoids curl TLS issues)"""
import os
import sys
import subprocess
import shutil
import tempfile
from pathlib import Path
from datetime import datetime

def check_system_time():
    """Check if system time is correct (critical for SSL/TLS)"""
    try:
        import time
        current_time = time.time()
        # Check if time is reasonable (between 2020 and 2030)
        min_time = 1577836800  # 2020-01-01
        max_time = 1893456000  # 2030-01-01
        
        if current_time < min_time or current_time > max_time:
            print("⚠ WARNING: System time appears incorrect!")
            print(f"  Current Unix timestamp: {current_time}")
            print(f"  Expected range: {min_time} - {max_time}")
            print("  SSL/TLS connections will fail with incorrect system time.")
            print("  Fix with: sudo ntpdate -s time.nist.gov  (or similar)")
            return False
        return True
    except Exception as e:
        print(f"⚠ Could not verify system time: {e}")
        return True  # Assume OK if we can't check

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
        # Try with verify=True first
        try:
            response = requests.get(url, stream=True, verify=True, timeout=60)
            response.raise_for_status()
        except requests.exceptions.SSLError:
            # If SSL fails, try with verify=False (less secure but works)
            print("⚠ SSL verification failed, trying without verification...")
            response = requests.get(url, stream=True, verify=False, timeout=60)
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
            
            with urllib.request.urlopen(url, context=ctx, timeout=60) as response:
                with open(dest_path, 'wb') as f:
                    shutil.copyfileobj(response, f)
            print(f"✓ Downloaded to {dest_path}")
            return True
        except ssl.SSLError:
            # Try with unverified context as last resort
            print("⚠ SSL error, trying with unverified context...")
            ctx = ssl._create_unverified_context()
            with urllib.request.urlopen(url, context=ctx, timeout=60) as response:
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

def download_agave_direct(version="2.1.8"):
    """Download Agave release tarball directly (bypasses installer TLS issues)"""
    print(f"=== Downloading Agave {version} directly ===")
    
    import ssl
    import urllib.request
    
    url = f"https://github.com/anza-xyz/agave/releases/download/v{version}/solana-release-x86_64-unknown-linux-gnu.tar.bz2"
    tarball_path = Path(tempfile.gettempdir()) / f"solana-release-{version}.tar.bz2"
    extract_dir = Path(tempfile.gettempdir()) / "solana-release"
    
    try:
        print(f"Downloading {url}...")
        # Create unverified SSL context to bypass TLS issues
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        
        # Use urlopen instead of urlretrieve (urlretrieve doesn't support context in older Python)
        with urllib.request.urlopen(url, context=ctx, timeout=300) as response:
            with open(tarball_path, 'wb') as f:
                shutil.copyfileobj(response, f)
        print(f"✓ Downloaded to {tarball_path}")
        
        # Extract tarball
        print(f"Extracting to {extract_dir}...")
        if extract_dir.exists():
            shutil.rmtree(extract_dir)
        extract_dir.mkdir(parents=True, exist_ok=True)
        
        subprocess.run(
            ['tar', '-xjf', str(tarball_path), '-C', str(extract_dir.parent)],
            check=True,
            timeout=300
        )
        print(f"✓ Extracted to {extract_dir}")
        
        # Install to standard location
        solana_home = Path.home() / ".local" / "share" / "solana" / "install"
        solana_home.mkdir(parents=True, exist_ok=True)
        active_release = solana_home / "active_release"
        
        # Remove old symlink/directory if exists
        if active_release.exists() or active_release.is_symlink():
            if active_release.is_symlink():
                active_release.unlink()
            else:
                shutil.rmtree(active_release)
        
        # Create symlink to extracted release
        active_release.symlink_to(extract_dir)
        print(f"✓ Linked {active_release} -> {extract_dir}")
        
        # Update PATH
        solana_bin = active_release / "bin"
        os.environ['PATH'] = f"{solana_bin}:{os.environ.get('PATH', '')}"
        
        # Verify installation
        solana_exe = solana_bin / "solana"
        if solana_exe.exists():
            result = subprocess.run(
                [str(solana_exe), '--version'],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                print(f"✓ Solana CLI installed: {result.stdout.strip()}")
                return True
        
        print("⚠ Installation completed but verification failed")
        return False
        
    except Exception as e:
        print(f"✗ Direct download failed: {e}")
        return False

def install_solana_cli():
    """Install Solana CLI using Python"""
    print("=== Installing Solana CLI ===")
    
    # Check if already installed in multiple locations
    solana_bin = Path.home() / ".local" / "share" / "solana" / "install" / "active_release" / "bin"
    solana_path = shutil.which('solana')
    
    if (solana_bin / "solana").exists():
        print(f"✓ Solana CLI already installed at {solana_bin}")
        # Update PATH for this session
        os.environ['PATH'] = f"{solana_bin}:{os.environ.get('PATH', '')}"
        return True
    elif solana_path:
        print(f"✓ Solana CLI found in PATH at {solana_path}")
        # Extract directory and add to PATH
        solana_dir = str(Path(solana_path).parent)
        os.environ['PATH'] = f"{solana_dir}:{os.environ.get('PATH', '')}"
        return True
    
    # Try multiple download methods
    installer_url = "https://release.solana.com/stable/install"
    installer_path = Path(tempfile.gettempdir()) / "solana-install.sh"
    
    # Try downloading with requests first
    if not download_with_requests(installer_url, installer_path):
        print("⚠ Installer script download failed, trying alternative methods...")
        
        # Try using curl if available
        curl_path = shutil.which('curl')
        if curl_path:
            print("Trying curl...")
            try:
                result = subprocess.run(
                    [curl_path, '-sSfL', installer_url],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=60
                )
                installer_path.write_text(result.stdout)
                os.chmod(installer_path, 0o755)
                print("✓ Downloaded via curl")
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                print(f"✗ Curl download failed: {e}")
                print("\n⚠ All installer methods failed, trying direct Agave download...")
                # Fallback to direct Agave download
                if download_agave_direct("2.1.8"):
                    return True
                print("\nERROR: All download methods failed")
                print("\nManual installation options:")
                print("1. Install requests library: pip3 install --user requests")
                print("2. Install Solana manually: sh -c \"$(curl -sSfL https://release.solana.com/stable/install)\"")
                print("3. Download installer manually and place at:", installer_path)
                return False
        else:
            print("\n⚠ Curl not available, trying direct Agave download...")
            # Fallback to direct Agave download
            if download_agave_direct("2.1.8"):
                return True
            print("\nERROR: All download methods failed")
            print("\nManual installation options:")
            print("1. Install requests library: pip3 install --user requests")
            print("2. Install curl: sudo apt-get install curl")
            print("3. Install Solana manually: sh -c \"$(curl -sSfL https://release.solana.com/stable/install)\"")
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
    
    # Check system time first (critical for SSL)
    if not check_system_time():
        print("\n⚠ System time check failed. SSL connections may fail.")
        print("  Attempting to continue anyway...\n")
    
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
    # Check system time first
    check_system_time()
    
    # Try to ensure requests is available for better TLS handling
    ensure_requests()
    
    if install_platform_tools():
        verify_installation()
        sys.exit(0)
    else:
        sys.exit(1)

