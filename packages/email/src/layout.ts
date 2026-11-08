/** A table-based HTML layout (logo, content, footer) and blocks for the content: RTL-aware, branded. */
import { escapeHtml } from "./placeholders.ts";

const DEFAULT_PRIMARY_COLOR = "#000000";
const DEFAULT_BACKGROUND_COLOR = "#f5f5f5";
const CONTENT_BACKGROUND_COLOR = "#ffffff";

export interface EmailBranding {
	companyName: string;
	logoUrl?: string;
	supportEmail: string;
	/** buttons, links and the logo fallback; default #000000 */
	primaryColor?: string;
}

export interface LayoutLabels {
	/** before the support address, e.g. "Support:" */
	support: string;
	unsubscribe: string;
}

const LABELS: Record<string, LayoutLabels> = {
	en: { support: "Support:", unsubscribe: "Unsubscribe" },
	ar: { support: "للدعم:", unsubscribe: "إلغاء الاشتراك" },
};

const RTL = new Set(["ar", "fa", "he", "ur"]);

/** "rtl" for Arabic, Persian, Hebrew and Urdu (and their regional tags). */
export function textDirection(language: string): "ltr" | "rtl" {
	return RTL.has(language.split("-")[0]!.toLowerCase()) ? "rtl" : "ltr";
}

/** The footer's words in `language`: English and Arabic built in, English for the rest. */
export function layoutLabels(language: string): LayoutLabels {
	return LABELS[language.split("-")[0]!.toLowerCase()] ?? LABELS.en!;
}

export interface LayoutOptions {
	language?: string;
	/** a footer link to it is added when given */
	unsubscribeUrl?: string;
	/** override the footer's words */
	labels?: LayoutLabels;
	/** for tests: the footer's year */
	year?: number;
}

/** Wraps a message's inner HTML in the layout. */
export function wrapEmailContent(
	innerHtml: string,
	branding: EmailBranding,
	options: LayoutOptions = {},
): string {
	const language = options.language ?? "en";
	const { unsubscribeUrl } = options;
	const labels = options.labels ?? layoutLabels(language);
	const primaryColor = branding.primaryColor || DEFAULT_PRIMARY_COLOR;
	const currentYear = options.year ?? new Date().getFullYear();
	const dir = textDirection(language);
	const supportLabel = labels.support;

	// no logo: the first letter of the name on the primary colour
	const logoSection = branding.logoUrl
		? `<img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(branding.companyName)}" style="max-width: 150px; max-height: 60px; display: block; margin: 0 auto;" />`
		: `<div style="background-color: ${primaryColor}; width: 48px; height: 48px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; margin: 0 auto;">
        <span style="color: #ffffff; font-size: 24px; font-weight: bold;">${escapeHtml(branding.companyName.charAt(0).toUpperCase())}</span>
      </div>`;

	return `<!DOCTYPE html>
<html lang="${language}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${escapeHtml(branding.companyName)}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style type="text/css">
    /* Reset styles */
    body, table, td, p, a, li, blockquote {
      -webkit-text-size-adjust: 100%;
      -ms-text-size-adjust: 100%;
    }
    table, td {
      mso-table-lspace: 0pt;
      mso-table-rspace: 0pt;
    }
    img {
      -ms-interpolation-mode: bicubic;
      border: 0;
      height: auto;
      line-height: 100%;
      outline: none;
      text-decoration: none;
    }
    body {
      margin: 0 !important;
      padding: 0 !important;
      width: 100% !important;
      height: 100% !important;
    }
    /* iOS blue link fix */
    a[x-apple-data-detectors] {
      color: inherit !important;
      text-decoration: none !important;
      font-size: inherit !important;
      font-family: inherit !important;
      font-weight: inherit !important;
      line-height: inherit !important;
    }
    /* Gmail fix */
    u + #body a {
      color: inherit;
      text-decoration: none;
      font-size: inherit;
      font-family: inherit;
      font-weight: inherit;
      line-height: inherit;
    }
    /* Button styles */
    .button {
      background-color: ${primaryColor};
      border-radius: 8px;
      color: #ffffff !important;
      display: inline-block;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 16px;
      font-weight: 600;
      line-height: 1;
      padding: 14px 28px;
      text-align: center;
      text-decoration: none;
      -webkit-text-size-adjust: none;
    }
    .button:hover {
      background-color: #333333;
    }
    /* Responsive */
    @media only screen and (max-width: 600px) {
      .container {
        width: 100% !important;
        max-width: 100% !important;
      }
      .content-padding {
        padding-left: 20px !important;
        padding-right: 20px !important;
      }
    }
  </style>
</head>
<body id="body" style="margin: 0; padding: 0; background-color: ${DEFAULT_BACKGROUND_COLOR}; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; direction: ${dir};" dir="${dir}">
  <!-- Wrapper table -->
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: ${DEFAULT_BACKGROUND_COLOR};">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <!-- Container -->
        <table role="presentation" class="container" cellpadding="0" cellspacing="0" width="600" style="max-width: 600px; background-color: ${CONTENT_BACKGROUND_COLOR}; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
          <!-- Header with logo -->
          <tr>
            <td align="center" style="padding: 32px 40px 24px 40px;">
              ${logoSection}
            </td>
          </tr>

          <!-- Main content -->
          <tr>
            <td class="content-padding" dir="${dir}" style="padding: 0 40px 32px 40px; direction: ${dir};">
              ${innerHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; background-color: #fafafa; border-top: 1px solid #eeeeee;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center" style="color: #888888; font-size: 13px; line-height: 1.6;">
                    <p style="margin: 0 0 8px 0;">
                      ${escapeHtml(branding.companyName)} &copy; ${currentYear}
                    </p>
                    <p style="margin: 0;">
                      ${supportLabel} <a href="mailto:${escapeHtml(branding.supportEmail)}" style="color: ${primaryColor}; text-decoration: none;">${escapeHtml(branding.supportEmail)}</a>
                    </p>
                    ${unsubscribeUrl ? `<p style="margin: 8px 0 0 0;"><a href="${escapeHtml(unsubscribeUrl)}" style="color: #888888; text-decoration: underline;">${escapeHtml(labels.unsubscribe)}</a></p>` : ""}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** A primary call-to-action button (VML for Outlook). */
export function createEmailButton(
	text: string,
	url: string,
	primaryColor = DEFAULT_PRIMARY_COLOR,
): string {
	return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin: 24px 0;">
      <tr>
        <td align="center">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${escapeHtml(url)}" style="height:48px;v-text-anchor:middle;width:200px;" arcsize="17%" strokecolor="${primaryColor}" fillcolor="${primaryColor}">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;font-size:16px;font-weight:600;">${escapeHtml(text)}</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${escapeHtml(url)}" class="button" style="background-color: ${primaryColor}; border-radius: 8px; color: #ffffff; display: inline-block; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 16px; font-weight: 600; line-height: 1; padding: 14px 28px; text-align: center; text-decoration: none;">
            ${escapeHtml(text)}
          </a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>`;
}

/** A secondary, outlined button. */
export function createEmailButtonOutline(
	text: string,
	url: string,
	primaryColor = DEFAULT_PRIMARY_COLOR,
): string {
	return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin: 24px 0;">
      <tr>
        <td align="center">
          <a href="${escapeHtml(url)}" style="background-color: transparent; border: 2px solid ${primaryColor}; border-radius: 8px; color: ${primaryColor}; display: inline-block; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 16px; font-weight: 600; line-height: 1; padding: 12px 26px; text-align: center; text-decoration: none;">
            ${escapeHtml(text)}
          </a>
        </td>
      </tr>
    </table>`;
}

/** A label: value row for `createDetailsCard`. */
export function createDetailRow(label: string, value: string, dir: "ltr" | "rtl" = "ltr"): string {
	const textAlign = dir === "rtl" ? "right" : "left";
	return `
    <tr>
      <td style="padding: 8px 0; color: #666666; font-size: 14px; white-space: nowrap; width: 40%; text-align: ${textAlign};">${escapeHtml(label)}</td>
      <td style="padding: 8px 0; color: #333333; font-size: 14px; font-weight: 500; text-align: ${textAlign};">${escapeHtml(value)}</td>
    </tr>`;
}

/** A titled box of label: value rows. */
export function createDetailsCard(
	title: string,
	rows: Array<{ label: string; value: string }>,
	dir: "ltr" | "rtl" = "ltr",
): string {
	const textAlign = dir === "rtl" ? "right" : "left";
	const rowsHtml = rows.map((r) => createDetailRow(r.label, r.value, dir)).join("");

	return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" dir="${dir}" style="background-color: #f9f9f9; border-radius: 8px; margin: 20px 0; direction: ${dir};">
      <tr>
        <td style="padding: 20px;">
          <p style="margin: 0 0 16px 0; font-size: 15px; font-weight: 600; color: #333333; text-align: ${textAlign};">
            ${escapeHtml(title)}
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" dir="${dir}">
            ${rowsHtml}
          </table>
        </td>
      </tr>
    </table>`;
}

/** A small coloured pill. */
export function createStatusBadge(
	text: string,
	variant: "success" | "warning" | "error" | "info" = "info",
): string {
	const colors = {
		success: { bg: "#e8f5e9", text: "#2e7d32" },
		warning: { bg: "#fff3e0", text: "#ef6c00" },
		error: { bg: "#ffebee", text: "#c62828" },
		info: { bg: "#e3f2fd", text: "#1565c0" },
	};

	const color = colors[variant];

	return `<span style="display: inline-block; padding: 4px 12px; background-color: ${color.bg}; color: ${color.text}; font-size: 12px; font-weight: 600; border-radius: 12px;">${escapeHtml(text)}</span>`;
}
