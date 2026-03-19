import { chromium, Browser, BrowserContext, Page } from "playwright";
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const COOKIES_PATH = path.join(DATA_DIR, "cookies.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const FRONTIER_HOME_URL = "https://www.flyfrontier.com/";
const FRONTIER_FAQ_URL = "https://faq.flyfrontier.com/help";

// Store browser instance for login flow
let loginBrowser: Browser | null = null;
let loginPage: Page | null = null;

export interface StoredCookies {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  savedAt: number;
}

/**
 * Check if cookies file exists and has non-expired cookies
 */
export function hasCookies(): boolean {
  if (!fs.existsSync(COOKIES_PATH)) {
    return false;
  }
  
  // Also check if cookies are expired
  try {
    const data = fs.readFileSync(COOKIES_PATH, "utf-8");
    const parsed = JSON.parse(data) as StoredCookies;
    
    // Check if we have any cookies
    if (!parsed.cookies || parsed.cookies.length === 0) {
      return false;
    }
    
    // Check if session is older than 7 days (Frontier sessions typically expire)
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
    if (parsed.savedAt && (Date.now() - parsed.savedAt) > maxAge) {
      console.log("[Playwright] Session is older than 7 days, may be expired");
      // Still return true but log warning - actual validation will happen on use
    }
    
    const usableFrontierCookies = parsed.cookies.filter(
      (c) =>
        c.domain.includes("flyfrontier.com") &&
        !/^(_px|pxcts|_gcl_)/i.test(c.name)
    );

    if (usableFrontierCookies.length === 0) {
      console.log("[Playwright] Warning: No non-tracking Frontier cookies found");
    }
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Get saved cookies
 */
export function getSavedCookies(): StoredCookies | null {
  if (!hasCookies()) {
    return null;
  }
  try {
    const data = fs.readFileSync(COOKIES_PATH, "utf-8");
    return JSON.parse(data) as StoredCookies;
  } catch {
    return null;
  }
}

/**
 * Save cookies to file
 */
async function saveCookies(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  const data: StoredCookies = {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })),
    savedAt: Date.now(),
  };
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(data, null, 2));
}

/**
 * Delete saved cookies
 */
export function deleteCookies(): void {
  if (fs.existsSync(COOKIES_PATH)) {
    fs.unlinkSync(COOKIES_PATH);
  }
}

/**
 * Start the login flow - opens a headed browser for manual login
 * Returns when the browser is ready for user interaction
 */
export async function startLoginFlow(): Promise<{ status: string }> {
  if (loginBrowser) {
    await loginBrowser.close();
    loginBrowser = null;
    loginPage = null;
  }

  loginBrowser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await loginBrowser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  loginPage = await context.newPage();

  // Open a live Frontier page
  await loginPage.goto(FRONTIER_HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Try a few possible sign-in triggers
  const loginTriggers = [
    'text=/sign in/i',
    'text=/my trips/i',
    'text=/frontier miles/i',
    '[aria-label*="sign" i]',
    'button:has-text("Sign In")',
    'a:has-text("Sign In")',
  ];

  let clicked = false;
  for (const selector of loginTriggers) {
    try {
      const el = loginPage.locator(selector).first();
      if (await el.isVisible({ timeout: 3000 })) {
        console.log("[Playwright] Clicking login trigger:", selector);
        await el.click();
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    return { status: "waiting_for_login_manual_navigation" };
  }

  // Wait for the sidebar/modal fields to appear
  await loginPage.waitForSelector('input[type="password"]', { timeout: 15000 });

  return { status: "waiting_for_login" };
}

/**
 * Check if login is complete and save cookies
 */
export async function checkLoginStatus(): Promise<{
  status: "waiting" | "logged_in" | "error" | "no_browser";
  message: string;
}> {
  if (!loginBrowser || !loginPage) {
    return { status: "no_browser", message: "No login session in progress" };
  }

  try {
    const context = loginPage.context();
    const cookies = await context.cookies();

    // Print cookie names once for debugging
    console.log(
      "[Playwright] Cookies after login attempt:",
      cookies.map((c) => `${c.domain} :: ${c.name}`)
    );

    const frontierCookies = cookies.filter((c) =>
      c.domain.includes("flyfrontier.com")
    );

    if (frontierCookies.length === 0) {
      return { status: "waiting", message: "No Frontier cookies detected yet" };
    }

    const nonTrackingCookies = frontierCookies.filter(
      (c) => !/^(_px|pxcts|_gcl_)/i.test(c.name)
    );

    console.log(
      "[Playwright] Non-tracking Frontier cookies:",
      nonTrackingCookies.map((c) => `${c.domain} :: ${c.name}`)
    );

    if (nonTrackingCookies.length === 0) {
      return {
        status: "waiting",
        message: "Only tracking/bot cookies detected so far; waiting for real session state",
      };
    }

    console.log("[Playwright] Current login page URL:", loginPage.url());

    const pageText = await loginPage.locator("body").innerText().catch(() => "");

    // Require stronger proof of login, not just generic site text
    const hasStrongLoggedInUi =
      /log out|logout|my account|sign out|profile|manage trips/i.test(pageText);

    // Also reject obvious logged-out/login-drawer states
    const stillShowsLoginForm =
      /login to frontier miles|email address or frontier miles|forgot password/i.test(pageText);

    if (stillShowsLoginForm) {
      return {
        status: "waiting",
        message: "Login form still visible. Please finish logging in in the Frontier browser window",
      };
    }

    if (!hasStrongLoggedInUi) {
      return {
        status: "waiting",
        message: "Waiting for a confirmed logged-in Frontier page",
      };
    }

    await saveCookies(context);

    await loginBrowser.close();
    loginBrowser = null;
    loginPage = null;

    return { status: "logged_in", message: "Login successful! Cookies saved." };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Cancel the login flow
 */
export async function cancelLoginFlow(): Promise<void> {
  if (loginBrowser) {
    await loginBrowser.close();
    loginBrowser = null;
    loginPage = null;
  }
}

/**
 * Get an authenticated browser context using saved cookies
 * Throws if no cookies or session expired
 */
export async function getAuthenticatedContext(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const savedCookies = getSavedCookies();

  if (!savedCookies) {
    throw new Error("No saved cookies. Please log in first.");
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  // Add saved cookies
  await context.addCookies(savedCookies.cookies);

  const page = await context.newPage();

  return { browser, context, page };
}

/**
 * Check if session is valid by trying to access account page
 */
export async function validateSession(): Promise<{
  valid: boolean;
  message: string;
}> {
  let browser: Browser | null = null;

  try {
    const auth = await getAuthenticatedContext();
    browser = auth.browser;
    const page = auth.page;

    await page.goto(FRONTIER_HOME_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const cookies = await page.context().cookies();
    const frontierCookies = cookies.filter((c) =>
      c.domain.includes("flyfrontier.com")
    );

    if (frontierCookies.length === 0) {
      //deleteCookies();
      return { valid: false, message: "No Frontier session cookies found." };
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const looksLoggedOut = /sign in|log in/i.test(bodyText) && !/log out|my account/i.test(bodyText);

    if (looksLoggedOut) {
      //deleteCookies();
      return { valid: false, message: "Session appears logged out. Please log in again." };
    }

    return { valid: true, message: "Session is valid" };
  } catch (error) {
    return {
      valid: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export const playwright = {
  hasCookies,
  getSavedCookies,
  deleteCookies,
  startLoginFlow,
  checkLoginStatus,
  cancelLoginFlow,
  getAuthenticatedContext,
  validateSession,
};

export default playwright;
