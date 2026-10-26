# Builds the two downloadable zips into public/ so the site serves them.
import shutil, tempfile, os
root = os.path.dirname(os.path.abspath(__file__))
for src, name in (("extension", "lock-in-blocker"), ("helper", "lock-in-game-closer")):
    with tempfile.TemporaryDirectory() as tmp:
        shutil.copytree(os.path.join(root, src), os.path.join(tmp, name))
        shutil.make_archive(os.path.join(root, "public", name), "zip", tmp, name)
print("packed")
