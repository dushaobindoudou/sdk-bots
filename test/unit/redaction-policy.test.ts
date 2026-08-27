/**
 * Unit tests for the redaction policy core (src/lib/redaction/).
 *
 * allowedPurpose() is the privacy truth table every proto field stamps
 * through (fan-in 115 across the tree): a regression here silently changes
 * what may be stored, logged, or used for training. These tests pin the
 * whole matrix plus the factory carriers that transport it.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  DataClassification,
  PrivacyCapability,
  SENSITIVE_CLASSIFICATIONS,
  allowedPurpose,
} from "../../src/lib/redaction/classification.ts";
import { PrivacyMode } from "../../src/lib/redaction/privacy-mode.ts";
import { createRedactedString, safeString } from "../../src/lib/redaction/factory.ts";

const CLASSIFICATIONS = Object.values(DataClassification) as DataClassification[];
const STORAGE_PURPOSES = [
  PrivacyCapability.STORAGE_FOR_TRAINING,
  PrivacyCapability.STORAGE_FOR_LOGGING,
  PrivacyCapability.STORAGE_FOR_USAGE,
] as const;

describe("allowedPurpose() — privacy truth table", () => {
  test("SAFE data is always allowed, under every mode and purpose", () => {
    for (const mode of Object.values(PrivacyMode)) {
      for (const purpose of STORAGE_PURPOSES) {
        assert.equal(
          allowedPurpose(mode, purpose, DataClassification.SAFE),
          true,
          `SAFE must pass ${purpose} under ${mode}`,
        );
      }
    }
  });

  test("UNSAFE_ALWAYS_ALLOWED bypasses every classification, even credentials", () => {
    for (const classification of CLASSIFICATIONS) {
      assert.equal(
        allowedPurpose(PrivacyMode.NO_STORAGE, PrivacyCapability.UNSAFE_ALWAYS_ALLOWED, classification),
        true,
      );
    }
  });

  test("CREDENTIALS and UNSPECIFIED are never stored under any mode", () => {
    for (const mode of Object.values(PrivacyMode)) {
      for (const purpose of STORAGE_PURPOSES) {
        assert.equal(allowedPurpose(mode, purpose, DataClassification.CREDENTIALS), false, `${mode}/${purpose}`);
        assert.equal(allowedPurpose(mode, purpose, DataClassification.UNSPECIFIED), false, `${mode}/${purpose}`);
      }
    }
  });

  test("NO_STORAGE (and UNSPECIFIED mode) stores nothing sensitive", () => {
    for (const classification of SENSITIVE_CLASSIFICATIONS) {
      for (const purpose of STORAGE_PURPOSES) {
        assert.equal(allowedPurpose(PrivacyMode.NO_STORAGE, purpose, classification), false);
        assert.equal(allowedPurpose(PrivacyMode.UNSPECIFIED, purpose, classification), false);
      }
    }
  });

  test("NO_TRAINING: logging only PATH/PROVIDER_INFO, usage everything, training nothing", () => {
    const mode = PrivacyMode.NO_TRAINING;
    assert.equal(allowedPurpose(mode, PrivacyCapability.STORAGE_FOR_LOGGING, DataClassification.PATH), true);
    assert.equal(allowedPurpose(mode, PrivacyCapability.STORAGE_FOR_LOGGING, DataClassification.PROVIDER_INFO), true);
    assert.equal(allowedPurpose(mode, PrivacyCapability.STORAGE_FOR_LOGGING, DataClassification.CODE), false);
    const storable = [DataClassification.CODE, DataClassification.PATH, DataClassification.PROVIDER_INFO];
    for (const classification of storable) {
      assert.equal(allowedPurpose(mode, PrivacyCapability.STORAGE_FOR_TRAINING, classification), false);
      assert.equal(allowedPurpose(mode, PrivacyCapability.STORAGE_FOR_USAGE, classification), true);
    }
  });

  test("permissive modes allow every storage purpose for storable classifications", () => {
    for (const mode of [PrivacyMode.USAGE_DATA_TRAINING_ALLOWED, PrivacyMode.USAGE_CODEBASE_TRAINING_ALLOWED]) {
      for (const purpose of STORAGE_PURPOSES) {
        assert.equal(allowedPurpose(mode, purpose, DataClassification.CODE), true, `${mode}/${purpose}`);
        assert.equal(allowedPurpose(mode, purpose, DataClassification.PATH), true, `${mode}/${purpose}`);
        // credentials stay sealed even in the most permissive mode
        assert.equal(allowedPurpose(mode, purpose, DataClassification.CREDENTIALS), false, `${mode}/${purpose}`);
      }
    }
  });

  test("unknown purposes are rejected loudly instead of defaulting to allow", () => {
    assert.throws(() => allowedPurpose(PrivacyMode.NO_TRAINING, "telemetry_or_worse" as PrivacyCapability, DataClassification.CODE), /Unknown purpose/);
  });
});

describe("redaction factory carriers", () => {
  test("createRedactedString transports value + classification + field name", () => {
    const redacted = createRedactedString("/home/u/secret", DataClassification.PATH, "workspace", PrivacyMode.NO_TRAINING);
    assert.equal(redacted.__classification, DataClassification.PATH);
    assert.equal(redacted.__fieldName, "workspace");
    assert.equal(redacted.__privacyMode, PrivacyMode.NO_TRAINING);
    assert.equal(redacted.__isRedacted, true, "PATH under NO_TRAINING must be marked for redaction");
  });

  test("safeString is SAFE-classified, never redacted, even under NO_STORAGE", () => {
    const value = safeString("hello world");
    assert.equal(value.__classification, DataClassification.SAFE);
    assert.equal(value.__isRedacted, false);
    assert.equal(allowedPurpose(PrivacyMode.NO_STORAGE, PrivacyCapability.STORAGE_FOR_LOGGING, value.__classification), true);
  });
});
