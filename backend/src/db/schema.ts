import type { Database } from 'better-sqlite3';

export const initializeDatabase = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS publishers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      company TEXT,
      website TEXT,
      domain TEXT,
      logo_url TEXT,
      docs_url TEXT,
      github_url TEXT,
      api_key TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS verifications (
      id TEXT PRIMARY KEY,
      publisher_id TEXT NOT NULL REFERENCES publishers(id),
      domain TEXT NOT NULL,
      challenge TEXT NOT NULL,
      verification_id TEXT,
      public_key TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      expires_at DATETIME NOT NULL,
      verified_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS apis (
      id TEXT PRIMARY KEY,
      publisher_id TEXT NOT NULL REFERENCES publishers(id),
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      base_url TEXT NOT NULL,
      auth_type TEXT NOT NULL,
      auth_config TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      slug TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS endpoints (
      id TEXT PRIMARY KEY,
      api_id TEXT NOT NULL REFERENCES apis(id),
      name TEXT NOT NULL,
      description TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      auth_required BOOLEAN NOT NULL DEFAULT 0,
      headers_schema TEXT,
      query_schema TEXT,
      path_params_schema TEXT,
      request_schema TEXT,
      response_schema TEXT,
      error_schema TEXT,
      example_request TEXT,
      example_response TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      publisher_id TEXT NOT NULL REFERENCES publishers(id),
      chain TEXT NOT NULL DEFAULT 'arc-testnet',
      address TEXT NOT NULL,
      settlement_frequency TEXT NOT NULL DEFAULT 'monthly',
      min_payout REAL NOT NULL DEFAULT 10,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pricing (
      id TEXT PRIMARY KEY,
      api_id TEXT NOT NULL REFERENCES apis(id),
      model TEXT NOT NULL DEFAULT 'PAY_PER_USE',
      price_per_request REAL NOT NULL,
      monthly_price REAL,
      included_requests INTEGER,
      overage_price REAL,
      currency TEXT NOT NULL DEFAULT 'USDC',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY,
      api_id TEXT NOT NULL REFERENCES apis(id),
      endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
      consumer_address TEXT,
      transaction_id TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      request_size INTEGER NOT NULL DEFAULT 0,
      response_size INTEGER NOT NULL DEFAULT 0,
      revenue REAL NOT NULL DEFAULT 0,
      platform_fee REAL NOT NULL DEFAULT 0,
      publisher_revenue REAL NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      api_id TEXT NOT NULL REFERENCES apis(id),
      tx_id TEXT UNIQUE NOT NULL,
      -- Fingerprint of the signed payment group; blocks replay of the same payment.
      payment_hash TEXT UNIQUE,
      payer_address TEXT NOT NULL,
      amount REAL NOT NULL,
      asset_id TEXT NOT NULL,
      network TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id TEXT PRIMARY KEY,
      publisher_id TEXT NOT NULL REFERENCES publishers(id),
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      amount REAL NOT NULL,
      platform_fee REAL NOT NULL,
      net_amount REAL NOT NULL,
      tx_id TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      period_start DATETIME NOT NULL,
      period_end DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS health_checks (
      id TEXT PRIMARY KEY,
      api_id TEXT NOT NULL REFERENCES apis(id),
      dns_ok BOOLEAN NOT NULL DEFAULT 0,
      https_ok BOOLEAN NOT NULL DEFAULT 0,
      tls_expiry DATETIME,
      endpoint_ok BOOLEAN NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      auth_ok BOOLEAN NOT NULL DEFAULT 0,
      schema_ok BOOLEAN NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OFFLINE',
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      api_id TEXT NOT NULL REFERENCES apis(id),
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Legacy. Superseded by users + custodial_wallets; kept only so existing
    -- deployments still open. Its plaintext mnemonics must be treated as compromised
    -- and the table dropped once those wallets are drained.
    CREATE TABLE IF NOT EXISTS email_wallets (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      address TEXT NOT NULL,
      mnemonic TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      avatar_url TEXT,
      email_verified BOOLEAN NOT NULL DEFAULT 0,
      auth_providers TEXT NOT NULL DEFAULT '[]',
      publisher_id TEXT REFERENCES publishers(id),
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT UNIQUE NOT NULL,
      user_agent TEXT,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Single-use magic-link tokens and OTP codes. Only hashes are stored.
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      kind TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at DATETIME NOT NULL,
      consumed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Backend-held accounts. Keys are AES-256-GCM encrypted at rest.
    CREATE TABLE IF NOT EXISTS custodial_wallets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      chain TEXT NOT NULL DEFAULT 'arc-testnet',
      address TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      opted_in BOOLEAN NOT NULL DEFAULT 0,
      funded_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, chain)
    );

    -- Append-only credit ledger. A user's balance is the sum of their rows, never a
    -- mutable column, so every movement stays auditable and reconstructable.
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      -- RECHARGE (money in), SPEND (API call), REFUND, ADJUST (manual correction)
      kind TEXT NOT NULL,
      -- Positive credits, negative debits, in USDC
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      -- 'crypto' | 'fiat' | 'system'
      source TEXT NOT NULL DEFAULT 'system',
      -- Provider or chain reference; unique so the same payment cannot be credited twice
      reference TEXT,
      description TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Batches of aggregated nanopayments settled on Arc Testnet
    CREATE TABLE IF NOT EXISTS nanopayment_batches (
      id TEXT PRIMARY KEY,
      batch_id TEXT UNIQUE NOT NULL,
      network TEXT NOT NULL,
      payer_address TEXT NOT NULL,
      recipient_address TEXT NOT NULL,
      total_amount REAL NOT NULL,
      payment_count INTEGER NOT NULL,
      tx_hash TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      settled_at DATETIME
    );

    -- EIP-3009 authorization nanopayments
    CREATE TABLE IF NOT EXISTS nanopayments (
      id TEXT PRIMARY KEY,
      api_id TEXT REFERENCES apis(id),
      endpoint_id TEXT REFERENCES endpoints(id),
      user_id TEXT REFERENCES users(id),
      batch_id TEXT REFERENCES nanopayment_batches(id),
      network TEXT NOT NULL,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      amount REAL NOT NULL,
      valid_after INTEGER NOT NULL,
      valid_before INTEGER NOT NULL,
      nonce TEXT UNIQUE NOT NULL,
      signature TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      settled_at DATETIME
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_reference
      ON credit_transactions(reference) WHERE reference IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_credit_user ON credit_transactions(user_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_email ON auth_tokens(email, kind);
    CREATE INDEX IF NOT EXISTS idx_usage_api ON usage(api_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_tx ON transactions(tx_id);
    CREATE INDEX IF NOT EXISTS idx_nanopayments_status ON nanopayments(status);
    CREATE INDEX IF NOT EXISTS idx_nanopayments_batch ON nanopayments(batch_id);
    CREATE INDEX IF NOT EXISTS idx_nanopayment_batches_status ON nanopayment_batches(status);
  `);
};
