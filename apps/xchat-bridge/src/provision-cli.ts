import { EnvelopeProtector } from "./crypto";
import { registerXChatIdentity, verifyXChatIdentity } from "./identity-registration";
import { runXChatProvisionCommand } from "./provision-command";
import { EncryptedFileVault } from "./vault";

const vaultPath = process.env.XCHAT_VAULT_PATH?.trim() || "/data/xchat-vault.json";

const command = await runXChatProvisionCommand({
  args: process.argv.slice(2),
  env: process.env,
  identityRegistration: async (input) => {
    const encodedKey = process.env.XCHAT_VAULT_ENCRYPTION_KEY?.trim();
    if (!encodedKey) throw new Error("XCHAT_VAULT_ENCRYPTION_KEY is required");
    return await registerXChatIdentity({
      ...input,
      vault: new EncryptedFileVault(vaultPath, new EnvelopeProtector(encodedKey)),
    });
  },
  identityVerification: async (input) => {
    const encodedKey = process.env.XCHAT_VAULT_ENCRYPTION_KEY?.trim();
    if (!encodedKey) return undefined;
    return await verifyXChatIdentity({
      ...input,
      vault: new EncryptedFileVault(vaultPath, new EnvelopeProtector(encodedKey)),
    });
  },
});
process.stdout.write(command.output);
process.exitCode = command.exitCode;
