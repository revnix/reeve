# Signing keys

The public keys reeve's decision records are signed with (#165), one file per
key, named by its key id: the sha256 of the key's DER encoding.

A host running reeve makes its own Ed25519 key the first time it keeps a
decision record, at `credentials/signing-ed25519.pem` in its home. Only its owner
can read the key, and no worker can. Its public half is written beside it, as
`signing-ed25519.pub`. To publish it, copy that file here as `<key id>.pub`.
`reeve why` names the key a record was signed with.

`reeve why` and `reeve replay` check each record against the keys here and the
host's own. A record signed by any other key, or whose signature doesn't hold,
reads as corrupt. One kept before records were signed reads as unsigned.

Keep a replaced key's file here, so the records it signed still check.
