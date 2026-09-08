import { config } from '../config';

export interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * The one call this module makes into `resend`. Declared structurally rather than importing
 * the SDK's types, because the dependency is loaded lazily and stays optional when no API
 * key is configured.
 */
interface ResendClient {
  emails: {
    send(payload: {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    }): Promise<{ error: { message?: string } | null }>;
  };
}

let resendClient: ResendClient | null = null;

const getResend = () => {
  if (!config.RESEND_API_KEY) return null;
  if (!resendClient) {
    // Required lazily so the dependency stays optional when no API key is configured.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional lazy load
    const { Resend } = require('resend');
    resendClient = new Resend(config.RESEND_API_KEY);
  }
  return resendClient;
};

/**
 * Send via Resend when configured. Without an API key the message is written to the
 * server log so magic links and OTP codes still work in local development.
 */
export const sendEmail = async (email: Email): Promise<{ delivered: boolean; channel: string }> => {
  const resend = getResend();

  if (!resend) {
    console.log(
      [
        '',
        '─────────────────────────────────────────────',
        ` EMAIL (console fallback — RESEND_API_KEY unset)`,
        ` To:      ${email.to}`,
        ` Subject: ${email.subject}`,
        '',
        email.text,
        '─────────────────────────────────────────────',
        '',
      ].join('\n'),
    );
    return { delivered: false, channel: 'console' };
  }

  const { error } = await resend.emails.send({
    from: config.EMAIL_FROM,
    to: email.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });

  if (error) throw new Error(`Email delivery failed: ${error.message || String(error)}`);
  return { delivered: true, channel: 'resend' };
};

const shell = (heading: string, body: string) => `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#111">
    <h1 style="font-size:18px;font-weight:600;margin:0 0 16px">${heading}</h1>
    ${body}
    <p style="font-size:12px;color:#666;margin-top:32px;border-top:1px solid #eee;padding-top:16px">
      If you didn't request this, you can ignore this email.
    </p>
  </div>
`;

export const magicLinkEmail = (to: string, link: string): Email => ({
  to,
  subject: 'Your sign-in link',
  html: shell(
    'Sign in to Spigot',
    `<p style="font-size:14px;line-height:1.6;margin:0 0 24px">Click the button below to sign in. This link expires in ${config.MAGIC_LINK_TTL_MINUTES} minutes and can be used once.</p>
     <a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:500">Sign in</a>
     <p style="font-size:12px;color:#666;margin-top:24px;word-break:break-all">${link}</p>`,
  ),
  text: `Sign in to Spigot\n\n${link}\n\nThis link expires in ${config.MAGIC_LINK_TTL_MINUTES} minutes and can be used once.`,
});

export const otpEmail = (to: string, code: string): Email => ({
  to,
  subject: `${code} is your verification code`,
  html: shell(
    'Your verification code',
    `<p style="font-size:14px;line-height:1.6;margin:0 0 24px">Enter this code to sign in. It expires in ${config.OTP_TTL_MINUTES} minutes.</p>
     <div style="font-size:32px;font-weight:600;letter-spacing:8px;font-family:ui-monospace,monospace">${code}</div>`,
  ),
  text: `Your verification code is ${code}\n\nIt expires in ${config.OTP_TTL_MINUTES} minutes.`,
});

export const payoutChangeEmail = (to: string, address: string, code: string): Email => ({
  to,
  subject: `Confirm your payout address change (${code})`,
  html: shell(
    'Confirm your payout address change',
    `<p style="font-size:14px;line-height:1.6;margin:0 0 16px">Someone asked to send your future API revenue to a new address:</p>
     <p style="font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;background:#f5f5f5;padding:12px;border-radius:8px;margin:0 0 24px">${address}</p>
     <p style="font-size:14px;line-height:1.6;margin:0 0 16px">Enter this code to approve it. It expires in 15 minutes.</p>
     <div style="font-size:32px;font-weight:600;letter-spacing:8px;font-family:ui-monospace,monospace">${code}</div>
     <p style="font-size:13px;color:#b00;margin-top:24px">If you did not request this, do not share the code — someone may have access to your account.</p>`,
  ),
  text: `Confirm your payout address change\n\nNew address: ${address}\nCode: ${code}\n\nThis expires in 15 minutes. If you did not request this, someone may have access to your account.`,
});
