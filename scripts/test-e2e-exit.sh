#!/usr/bin/env bash
set -euo pipefail
# Check the actual pipeline commands extracted from the workflow, replacing only
# Node with an intentional exit 37. A missing pipefail must fail this regression.
python3 - <<'PYTEST'
import pathlib, subprocess, tempfile
workflow = pathlib.Path('.github/workflows/ci.yml').read_text()
step = workflow.split('      - name: Seed real demonstration data and inspect both accounts')[1].split('      - name: Upload acceptance evidence')[0]
assert 'shell: bash' in step and 'set -euo pipefail' in step
for script in ('demo-data.browser.mjs', 'access-expiry.browser.mjs'):
    line = next(line.strip() for line in step.splitlines() if 'node frontend/e2e/' + script in line)
    with tempfile.TemporaryDirectory() as directory:
        command = line.replace('node frontend/e2e/' + script, "node -e 'process.exit(37)'").replace('work/mvp1-acceptance.txt', directory + '/protocol.txt')
        result = subprocess.run(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', command])
        assert result.returncode == 37, (script, result.returncode)
        assert pathlib.Path(directory, 'protocol.txt').exists()
        print('PASS', script, 'intentional exit 37 propagated; tee created protocol')
PYTEST
