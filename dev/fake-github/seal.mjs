// Seals argv[3] for the base64 public key argv[2] (libsodium crypto_box_seal), like the browser does.
import sodium from 'libsodium-wrappers';
await sodium.ready;
const pk = sodium.from_base64(process.argv[2], sodium.base64_variants.ORIGINAL);
process.stdout.write(sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(process.argv[3]), pk), sodium.base64_variants.ORIGINAL));
