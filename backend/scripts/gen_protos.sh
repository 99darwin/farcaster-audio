#!/usr/bin/env bash
# Regenerate the vendored Farcaster protobuf bindings in app/clients/proto/.
#
# Source: farcasterxyz/hub-monorepo protobufs/schemas (MIT, see
# app/clients/proto/LICENSE.hub-monorepo), pinned at commit
# 7e742a8dbbbdc2e6759482e633b44f34ce2bc869 ("bring protos to parity with
# Snapchain"). Field numbers for every message Juke builds (CastAdd,
# CastRemove, Reaction, Link, and the Message envelope incl. data_bytes=7)
# are identical in snapchain and the hypersnap fork. The newer snapchain and
# hypersnap copies are GPL-3.0, which is why the MIT hub-monorepo copy is
# vendored instead.
#
# Usage (from backend/):
#   pip install grpcio-tools
#   ./scripts/gen_protos.sh
#
# The generated *_pb2.py files are committed; only rerun this after
# updating the vendored .proto files. Bump the `protobuf` floor in
# requirements.txt to the gencode version printed in the generated
# header if grpcio-tools has moved on.
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROTO_DIR="${BACKEND_DIR}/app/clients/proto"
PYTHON="${PYTHON:-python3}"

"${PYTHON}" -m grpc_tools.protoc \
  --proto_path="${PROTO_DIR}" \
  --python_out="${PROTO_DIR}" \
  --pyi_out="${PROTO_DIR}" \
  "${PROTO_DIR}/username_proof.proto" \
  "${PROTO_DIR}/message.proto"

# The protos have no `package`, so protoc emits a top-level
# `import username_proof_pb2`. Rewrite it to a package-relative import so
# the bindings work as `app.clients.proto.message_pb2`.
for generated in "${PROTO_DIR}/message_pb2.py" "${PROTO_DIR}/message_pb2.pyi"; do
  sed -i.bak \
    -e 's/^import username_proof_pb2 as /from . import username_proof_pb2 as /' \
    -e 's/^from username_proof_pb2 import /from .username_proof_pb2 import /' \
    "${generated}"
  rm -f "${generated}.bak"
done

echo "Regenerated protobuf bindings in ${PROTO_DIR}"
