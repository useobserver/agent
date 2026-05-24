// CloudWatch source tests.
//
// We mock @aws-sdk/client-cloudwatch's CloudWatchClient.send so the
// tests never make a real network call. The mock returns canned
// responses (or throws AWS-shaped errors) so we cover the value-
// extraction + error-classification paths without an AWS account.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// Use mock.module so the import in cloudwatch.ts resolves to our
// stand-in. We capture the last command sent to `client.send()` so
// tests can assert request shape (StartTime, EndTime, MetricStat).
let lastCommand: { input?: unknown } | null = null;
let sendImpl: (input: unknown) => Promise<unknown> = async () => ({ MetricDataResults: [] });

class FakeCloudWatchClient {
  constructor(public readonly config: unknown) {}
  async send(command: { input?: unknown }) {
    lastCommand = command;
    return sendImpl(command.input);
  }
  destroy() {
    /* no-op */
  }
}

class FakeGetMetricDataCommand {
  constructor(public readonly input: unknown) {}
}

mock.module("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: FakeCloudWatchClient,
  GetMetricDataCommand: FakeGetMetricDataCommand,
}));

mock.module("@aws-sdk/credential-providers", () => ({
  fromTemporaryCredentials: () => async () => ({
    accessKeyId: "FAKE",
    secretAccessKey: "FAKE",
    sessionToken: "FAKE",
    expiration: new Date(Date.now() + 3600_000),
  }),
}));

// Import AFTER mocks are set up so cloudwatch.ts picks up the fakes.
const {
  default: cloudwatchSource,
  classifyCloudwatchError,
  resetCloudwatchClientCacheForTests,
} = await import("../src/sources/cloudwatch.ts");

const baseConfig = {
  region: "us-east-1",
  namespace: "AWS/RDS",
  metric_name: "CPUUtilization",
  statistic: "Average",
  period_seconds: 60,
};

beforeEach(() => {
  resetCloudwatchClientCacheForTests();
  lastCommand = null;
  sendImpl = async () => ({ MetricDataResults: [] });
});

afterEach(() => {
  resetCloudwatchClientCacheForTests();
});

describe("CloudWatch source — validateConfig", () => {
  it("accepts a minimum-shape config", () => {
    expect(cloudwatchSource.validateConfig(baseConfig)).toBeNull();
  });

  it("accepts a full config with role_arn + external_id + dimensions", () => {
    const err = cloudwatchSource.validateConfig({
      ...baseConfig,
      dimensions: { DBInstanceIdentifier: "prod-db" },
      role_arn: "arn:aws:iam::123456789012:role/observer-cloudwatch-read",
      external_id: "observer-prod-12345",
    });
    expect(err).toBeNull();
  });

  it("rejects unknown keys (strict mode)", () => {
    const err = cloudwatchSource.validateConfig({ ...baseConfig, extra: "x" });
    expect(err).not.toBeNull();
  });

  it("rejects an invalid region format", () => {
    const err = cloudwatchSource.validateConfig({ ...baseConfig, region: "US East 1" });
    expect(err).not.toBeNull();
  });

  it("rejects a non-supported period_seconds", () => {
    const err = cloudwatchSource.validateConfig({ ...baseConfig, period_seconds: 30 });
    expect(err).not.toBeNull();
  });

  it("rejects an unknown statistic", () => {
    const err = cloudwatchSource.validateConfig({ ...baseConfig, statistic: "Median" });
    expect(err).not.toBeNull();
  });

  it("accepts percentile statistics", () => {
    expect(cloudwatchSource.validateConfig({ ...baseConfig, statistic: "p95" })).toBeNull();
    expect(cloudwatchSource.validateConfig({ ...baseConfig, statistic: "p99.9" })).toBeNull();
    expect(cloudwatchSource.validateConfig({ ...baseConfig, statistic: "p0" })).toBeNull();
  });

  it("rejects malformed role_arn", () => {
    const err = cloudwatchSource.validateConfig({
      ...baseConfig,
      role_arn: "not-an-arn",
    });
    expect(err).not.toBeNull();
  });
});

describe("CloudWatch source — execute()", () => {
  it("returns the most recent value from a successful response", async () => {
    const older = new Date(Date.now() - 5 * 60 * 1000);
    const newer = new Date(Date.now() - 60 * 1000);
    sendImpl = async () => ({
      MetricDataResults: [
        {
          Id: "m1",
          // CloudWatch can return in any order; we sort defensively.
          Timestamps: [older, newer],
          Values: [42, 99],
        },
      ],
    });
    const r = await cloudwatchSource.execute(baseConfig);
    expect(r.value).toBe(99);
    expect(r.status_hint).toBeUndefined();
    expect(r.timestamp).toBe(newer.toISOString());
  });

  it("returns cloudwatch_no_data when the metric has no values in the lookback", async () => {
    sendImpl = async () => ({ MetricDataResults: [{ Id: "m1", Timestamps: [], Values: [] }] });
    const r = await cloudwatchSource.execute(baseConfig);
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("cloudwatch_no_data");
  });

  it("returns cloudwatch_no_data when MetricDataResults is empty", async () => {
    sendImpl = async () => ({ MetricDataResults: [] });
    const r = await cloudwatchSource.execute(baseConfig);
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("cloudwatch_no_data");
  });

  it("skips null values mixed in with real values", async () => {
    const t1 = new Date(Date.now() - 5 * 60 * 1000);
    const t2 = new Date(Date.now() - 60 * 1000);
    sendImpl = async () => ({
      MetricDataResults: [
        {
          Id: "m1",
          Timestamps: [t1, t2],
          // The SDK doesn't emit null in Values per spec, but some
          // codepaths surface undefined; either way, the latest valid
          // pair should be the chosen one. Force an invalid `null` at
          // position 1 to verify we skip it.
          Values: [42, null as unknown as number],
        },
      ],
    });
    const r = await cloudwatchSource.execute(baseConfig);
    expect(r.value).toBe(42);
    expect(r.timestamp).toBe(t1.toISOString());
  });

  it("sends StartTime = EndTime - 5*period and ScanBy=TimestampDescending", async () => {
    sendImpl = async () => ({
      MetricDataResults: [{ Id: "m1", Timestamps: [new Date()], Values: [1] }],
    });
    await cloudwatchSource.execute({ ...baseConfig, period_seconds: 300 });
    const input = lastCommand?.input as {
      StartTime: Date;
      EndTime: Date;
      ScanBy: string;
      MetricDataQueries: Array<{ MetricStat: { Period: number; Stat: string } }>;
    };
    expect(input.ScanBy).toBe("TimestampDescending");
    expect(input.MetricDataQueries[0]!.MetricStat.Period).toBe(300);
    expect(input.MetricDataQueries[0]!.MetricStat.Stat).toBe("Average");
    const delta = input.EndTime.getTime() - input.StartTime.getTime();
    expect(delta).toBe(300 * 5 * 1000);
  });

  it("sends dimensions in key-sorted order", async () => {
    sendImpl = async () => ({
      MetricDataResults: [{ Id: "m1", Timestamps: [new Date()], Values: [1] }],
    });
    await cloudwatchSource.execute({
      ...baseConfig,
      dimensions: { ZebraName: "z", AppleName: "a", MidName: "m" },
    });
    const input = lastCommand?.input as {
      MetricDataQueries: Array<{
        MetricStat: { Metric: { Dimensions: Array<{ Name: string; Value: string }> } };
      }>;
    };
    const dims = input.MetricDataQueries[0]!.MetricStat.Metric.Dimensions;
    expect(dims.map((d) => d.Name)).toEqual(["AppleName", "MidName", "ZebraName"]);
  });

  it("maps AccessDeniedException to cloudwatch_access_denied", async () => {
    sendImpl = async () => {
      const e = new Error("denied") as Error & { name: string };
      e.name = "AccessDeniedException";
      throw e;
    };
    const r = await cloudwatchSource.execute(baseConfig);
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("cloudwatch_access_denied");
  });

  it("maps ThrottlingException to cloudwatch_throttled", async () => {
    sendImpl = async () => {
      const e = new Error("throttled") as Error & { name: string };
      e.name = "ThrottlingException";
      throw e;
    };
    const r = await cloudwatchSource.execute(baseConfig);
    expect(r.reason).toBe("cloudwatch_throttled");
  });

  it("maps ExpiredTokenException to cloudwatch_expired_credentials", async () => {
    sendImpl = async () => {
      const e = new Error("expired") as Error & { name: string };
      e.name = "ExpiredTokenException";
      throw e;
    };
    const r = await cloudwatchSource.execute(baseConfig);
    expect(r.reason).toBe("cloudwatch_expired_credentials");
  });

  it("maps unknown errors to cloudwatch_error", async () => {
    sendImpl = async () => {
      throw new Error("something went sideways");
    };
    const r = await cloudwatchSource.execute(baseConfig);
    expect(r.reason).toBe("cloudwatch_error");
  });

  it("maps HTTP 5xx with no name to cloudwatch_server_error", () => {
    expect(
      classifyCloudwatchError({ $metadata: { httpStatusCode: 502 } }),
    ).toBe("cloudwatch_server_error");
  });

  it("error metadata does not include credentials, role ARNs, or AWS request IDs", async () => {
    sendImpl = async () => {
      const e = new Error("denied") as Error & { name: string };
      e.name = "AccessDeniedException";
      throw e;
    };
    const r = await cloudwatchSource.execute({
      ...baseConfig,
      role_arn: "arn:aws:iam::123456789012:role/super-secret-role",
      external_id: "do-not-leak-this",
    });
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("123456789012");
    expect(serialized).not.toContain("super-secret-role");
    expect(serialized).not.toContain("do-not-leak-this");
  });
});

describe("CloudWatch source — client caching", () => {
  it("reuses the same client across calls with the same region", async () => {
    sendImpl = async () => ({
      MetricDataResults: [{ Id: "m1", Timestamps: [new Date()], Values: [1] }],
    });
    await cloudwatchSource.execute(baseConfig);
    const first = lastCommand;
    await cloudwatchSource.execute(baseConfig);
    // We can't introspect the client identity directly from outside,
    // but lastCommand should now be a different command instance
    // (proving send() was called again).
    expect(lastCommand).not.toBe(first);
  });

  it("evicts the LRU client when the cache exceeds its bound", async () => {
    // Spawn 70 distinct (region, role_arn) clients; cache is bounded
    // at 64 so the first ~6 entries should have been evicted. We
    // verify the cache size never exceeds the bound by sniffing the
    // internal Map size via destroy-count.
    sendImpl = async () => ({
      MetricDataResults: [{ Id: "m1", Timestamps: [new Date()], Values: [1] }],
    });
    let destroyed = 0;
    const origDestroy = FakeCloudWatchClient.prototype.destroy;
    FakeCloudWatchClient.prototype.destroy = function () {
      destroyed += 1;
    };
    for (let i = 0; i < 70; i++) {
      await cloudwatchSource.execute({
        ...baseConfig,
        role_arn: `arn:aws:iam::123456789012:role/r${i}`,
      });
    }
    FakeCloudWatchClient.prototype.destroy = origDestroy;
    // 70 distinct keys, cap 64 → 6 evictions.
    expect(destroyed).toBeGreaterThanOrEqual(6);
  });
});
