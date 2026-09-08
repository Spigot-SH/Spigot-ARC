export interface Publisher {
  id: string;
  name: string;
  email: string;
  company?: string;
  website?: string;
  domain?: string;
  logo_url?: string;
  docs_url?: string;
  github_url?: string;
  api_key: string;
  status: 'ACTIVE' | 'INACTIVE';
  created_at: string;
  updated_at: string;
}

export interface Verification {
  id: string;
  publisher_id: string;
  domain: string;
  challenge: string;
  verification_id?: string;
  public_key?: string;
  status: 'PENDING' | 'VERIFIED' | 'FAILED' | 'EXPIRED';
  expires_at: string;
  verified_at?: string;
  created_at: string;
}

export interface Api {
  id: string;
  publisher_id: string;
  name: string;
  version: string;
  base_url: string;
  auth_type: 'NONE' | 'API_KEY' | 'BEARER' | 'OAUTH' | 'BASIC' | 'CUSTOM';
  auth_config: string;
  status: 'DRAFT' | 'TESTING' | 'READY' | 'PUBLISHED' | 'SUSPENDED';
  slug: string;
  created_at: string;
  updated_at: string;
}

export interface Endpoint {
  id: string;
  api_id: string;
  name: string;
  description?: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  auth_required: boolean;
  headers_schema?: string;
  query_schema?: string;
  path_params_schema?: string;
  request_schema?: string;
  response_schema?: string;
  error_schema?: string;
  example_request?: string;
  example_response?: string;
  created_at: string;
}

export interface Wallet {
  id: string;
  publisher_id: string;
  chain: string;
  address: string;
  settlement_frequency: 'daily' | 'weekly' | 'monthly';
  min_payout: number;
  created_at: string;
}

export interface Pricing {
  id: string;
  api_id: string;
  model: 'PAY_PER_USE' | 'SUBSCRIPTION';
  price_per_request: number;
  monthly_price?: number;
  included_requests?: number;
  overage_price?: number;
  currency: string;
  created_at: string;
}

export interface UsageRecord {
  id: string;
  api_id: string;
  endpoint_id: string;
  consumer_address?: string;
  transaction_id?: string;
  method: string;
  path: string;
  status_code: number;
  latency_ms: number;
  request_size: number;
  response_size: number;
  revenue: number;
  platform_fee: number;
  publisher_revenue: number;
  created_at: string;
}

export interface Transaction {
  id: string;
  api_id: string;
  tx_id: string;
  payer_address: string;
  amount: number;
  asset_id: string;
  network: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  created_at: string;
}

export interface Settlement {
  id: string;
  publisher_id: string;
  wallet_id: string;
  amount: number;
  platform_fee: number;
  net_amount: number;
  tx_id?: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  period_start: string;
  period_end: string;
  created_at: string;
}

export interface HealthCheck {
  id: string;
  api_id: string;
  dns_ok: boolean;
  https_ok: boolean;
  tls_expiry?: string;
  endpoint_ok: boolean;
  latency_ms: number;
  auth_ok: boolean;
  schema_ok: boolean;
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  error_message?: string;
  created_at: string;
}

export interface Skill {
  id: string;
  api_id: string;
  name: string;
}

export interface AuthToken {
  id: string;
  email: string;
  kind: string;
  token_hash: string;
  attempts: number;
  expires_at: string;
  consumed_at?: string;
  created_at: string;
}

export interface AuditLog {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  details: string;
  created_at: string;
}

export interface X402PaymentRequired {
  x402Version: number;
  accepts: {
    scheme: string;
    network: string;
    maxAmountRequired: string;
    resource?: string;
    payTo: string;
    asset: string;
    maxTimeoutSeconds?: number;
    description?: string;
    extra?: Record<string, unknown>;
  }[];
}

export interface X402PaymentSignature {
  x402Version: number;
  payment: {
    scheme: string;
    proof: string;
    [key: string]: unknown;
  };
}

export interface DashboardStats {
  available_balance: number;
  pending_balance: number;
  settled_balance: number;
  lifetime_revenue: number;
  requests_today: number;
  requests_month: number;
  revenue_today: number;
  revenue_month: number;
  avg_latency: number;
  success_rate: number;
  health_status: string;
}
