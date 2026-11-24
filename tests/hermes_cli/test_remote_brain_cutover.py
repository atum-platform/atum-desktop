import json
import pytest
from hermes_cli.remote_brain import enroll, validate_cutover


def test_freeze_requires_all_coverage_and_transport_before_any_write(tmp_path):
    root = tmp_path / 'local-brain'
    root.mkdir()
    home = tmp_path / 'home'
    with pytest.raises(ValueError, match='complete_coverage'):
        enroll(home, 'https://brain.example/mcp', local_brain_root=root)
    assert not home.exists() and not (root / 'cloud-readonly.json').exists()
    receipt = dict(schema='atum.awareness-cutover/1', localRoot=str(root),
        completeInventory=True, liveTransportProven=True,
        reports=[dict(complete=True, cutoverAllowed=True, gaps=[], ledgerSeq=1, approvedSha256='a'*64)])
    file = tmp_path / 'cutover.json'
    def write():
        file.write_text(json.dumps(receipt))
        file.chmod(0o600)
    write()
    assert validate_cutover(root, file) == receipt
    for flag in ('completeInventory', 'liveTransportProven'):
        receipt[flag] = False
        write()
        with pytest.raises(ValueError): validate_cutover(root, file)
        receipt[flag] = True
    receipt['reports'][0]['gaps'] = [{'reason':'missing'}]
    write()
    with pytest.raises(ValueError): validate_cutover(root, file)
