#!/bin/sh
# RETIRED/INERT: the executor image deliberately does not COPY this file. Allowing a shell wrapper
# would let an otherwise-approved Node payload execute /bin/sh. The live image uses the exact
# root-owned /usr/local/bin/godot symlink and sets XDG_DATA_HOME in the sanitized child environment.
echo "retired Godot shell wrapper must not execute" >&2
exit 78
