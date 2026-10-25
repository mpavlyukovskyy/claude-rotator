// Claude Dashboard: native macOS window around the local claude-rotator dashboard.
// Build: ./build.sh (it writes Config.swift with the dashboard URL and launchd label).
// Self-test: ClaudeDashboard --selftest out.png [--url http://127.0.0.1:17788/] [--click "#pollnow"] [--no-host-dialogs]
//   loads the page, waits for the dashboard to render, clicks the selectors 1.5 s apart, snapshots its own
//   window, prints DIALOGS=<host dialogs seen> and exits. --no-host-dialogs removes the WKUIDelegate.
import Cocoa
import WebKit

let args = CommandLine.arguments
func arg(_ name: String) -> String? { if let i = args.firstIndex(of: name), args.count > i + 1 { return args[i + 1] }; return nil }
let URLSTR = arg("--url") ?? DEFAULT_URL
let selftest = arg("--selftest")
let clicks = (arg("--click") ?? "").split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
let noHostDialogs = args.contains("--no-host-dialogs")
var hostDialogs = 0

func serverUp() -> Bool {
    var ok = false
    let sem = DispatchSemaphore(value: 0)
    var req = URLRequest(url: URL(string: URLSTR + "healthz")!); req.timeoutInterval = 3
    URLSession.shared.dataTask(with: req) { _, resp, _ in ok = (resp as? HTTPURLResponse) != nil; sem.signal() }.resume()
    _ = sem.wait(timeout: .now() + 4)
    return ok
}
func ensureServer() {
    if serverUp() { return }
    if arg("--url") != nil { return } // test server: nothing to restart
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    p.arguments = ["kickstart", "-k", "gui/\(getuid())/\(LAUNCHD_LABEL)"]
    try? p.run(); p.waitUntilExit()
    for _ in 0..<10 { if serverUp() { return }; Thread.sleep(forTimeInterval: 1) }
}

// Host-side JavaScript dialogs. WKWebView shows NOTHING for alert/confirm/prompt unless the app implements
// these; without them confirm() returns false at once. The page has its own modal; this is belt and
// braces for anything that still calls window.confirm/alert.
class UI: NSObject, WKUIDelegate {
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        hostDialogs += 1
        if selftest != nil { completionHandler(); return }
        let a = NSAlert(); a.messageText = "Claude Dashboard"; a.informativeText = m; a.addButton(withTitle: "OK"); a.runModal(); completionHandler()
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        hostDialogs += 1
        if selftest != nil { completionHandler(true); return }
        let a = NSAlert(); a.messageText = "Claude Dashboard"; a.informativeText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        hostDialogs += 1
        if selftest != nil { completionHandler(defaultText); return }
        let a = NSAlert(); a.messageText = p; let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24)); tf.stringValue = defaultText ?? ""; a.accessoryView = tf
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn ? tf.stringValue : nil)
    }
}

class App: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    let ui = UI()
    func applicationDidFinishLaunching(_ n: Notification) {
        ensureServer()
        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        if !noHostDialogs { web.uiDelegate = ui }
        web.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 960),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Claude Dashboard"
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("ClaudeDashboardMain")
        window.makeKeyAndOrderFront(nil)
        buildMenu()
        NSApp.activate(ignoringOtherApps: true)
        web.load(URLRequest(url: URL(string: URLSTR)!))
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        appMenu.addItem(withTitle: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "b")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Claude Dashboard", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        NSApp.mainMenu = main
    }
    @objc func reload() { ensureServer(); web.reload() }
    @objc func openBrowser() { NSWorkspace.shared.open(URL(string: URLSTR)!) }
    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError e: Error) {
        w.loadHTMLString("<body style='font:15px -apple-system;padding:40px;background:#1a1a19;color:#f2f2ee'><h2>Dashboard server not reachable</h2><p>\(e.localizedDescription)</p><p>Try Reload (⌘R). It restarts launchd job \(LAUNCHD_LABEL).</p></body>", baseURL: nil)
        if selftest != nil { FileHandle.standardError.write("SELFTEST load failed: \(e.localizedDescription)\n".data(using: .utf8)!); exit(2) }
    }
    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        guard let out = selftest else { return }
        var tries = 0
        func finish(_ t: String) {
            w.takeSnapshot(with: nil) { img, err in
                guard let img = img, let tiff = img.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { print("SELFTEST snapshot failed \(String(describing: err))"); exit(2) }
                try? png.write(to: URL(fileURLWithPath: out))
                print("SELFTEST OK meta='\(t)' clicks=\(clicks.count) DIALOGS=\(hostDialogs) size=\(Int(img.size.width))x\(Int(img.size.height)) -> \(out)")
                exit(0)
            }
        }
        func doClicks(_ i: Int, _ t: String) {
            if i >= clicks.count { DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { finish(t) }; return }
            let sel = clicks[i]
            let js = sel.hasPrefix("js:") ? String(sel.dropFirst(3)) : "(function(){var e=document.querySelector(\(String(reflecting: sel)));if(!e)return 'MISSING';if(e.disabled)return 'DISABLED';if(e.offsetParent===null&&e.id!=='dlg-ok'&&e.id!=='dlg-cancel')return 'HIDDEN';e.click();return 'CLICKED';})()"
            w.evaluateJavaScript(js) { v, err in
                print("CLICK \(sel) -> \(v ?? err?.localizedDescription ?? "?")")
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { doClicks(i + 1, t) }
            }
        }
        func poll() {
            tries += 1
            w.evaluateJavaScript("(document.querySelector('#meta')||{}).textContent||''") { v, _ in
                let t = (v as? String) ?? ""
                if !t.isEmpty && !t.contains("loading") { doClicks(0, t) }
                else if tries > 60 { print("SELFTEST timeout, meta='\(t)'"); exit(2) }
                else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: poll) }
            }
        }
        poll()
    }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
