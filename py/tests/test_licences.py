"""Fails if any installed distribution declares a (non-L)GPL licence."""
import re
from importlib import metadata

GPL = re.compile(r"(?<![L\w])A?GPL|GNU (Affero )?General Public License", re.I)
LGPL = re.compile(r"LGPL|Lesser General Public|Library General Public", re.I)


def declared(dist):
    md = dist.metadata
    fields = [md.get("License-Expression") or "", *md.get_all("Classifier", [])]
    lic = md.get("License") or ""
    if len(lic) < 200:  # short field = a name; long = pasted licence text
        fields.append(lic)
    return [f for f in fields if f]


def test_no_gpl_in_environment():
    bad = []
    for dist in metadata.distributions():
        for f in declared(dist):
            if GPL.search(f) and not LGPL.search(f):
                bad.append((dist.metadata["Name"], f))
    assert not bad, f"GPL/AGPL distributions installed: {bad}"
