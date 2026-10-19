"""Exercise the real VSIX asset contract enforced by the Marketplace importer."""

import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from scripts import distribution


class MarketplacePackageTest(unittest.TestCase):
    def test_addressable_assets_are_present_and_have_registered_content_types(self):
        with tempfile.TemporaryDirectory() as temporary:
            package, _ = distribution.build(Path(temporary))
            with zipfile.ZipFile(package) as archive:
                namespace = {"v": distribution.VSX}
                manifest = ET.fromstring(archive.read("extension.vsixmanifest"))
                content_types = ET.fromstring(archive.read("[Content_Types].xml"))
                types = {
                    item.attrib["Extension"].lstrip("."): item.attrib["ContentType"]
                    for item in content_types
                    if "Extension" in item.attrib
                }
                overrides = {
                    item.attrib["PartName"].lstrip("/"): item.attrib["ContentType"]
                    for item in content_types
                    if "PartName" in item.attrib
                }
                for asset in manifest.findall("v:Assets/v:Asset", namespace):
                    part = asset.attrib["Path"]
                    self.assertIn(part, archive.namelist(), asset.attrib["Type"])
                    content_type = overrides.get(part) or types.get(
                        Path(part).suffix.lstrip(".")
                    )
                    self.assertTrue(content_type, f"Unregistered Marketplace part: {part}")
                licence = manifest.findtext("v:Metadata/v:License", namespaces=namespace)
                self.assertEqual(licence, "extension/LICENSE.txt")
                self.assertEqual(types["txt"], "text/plain")
                self.assertEqual(
                    archive.read(licence), (distribution.ROOT / "LICENSE").read_bytes()
                )


if __name__ == "__main__":
    unittest.main()
