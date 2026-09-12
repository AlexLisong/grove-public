# Grove Capture

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this directory. Create a Grove token in Settings with workspace read/write scopes; connect the URL, token and workspace ID from the extension options. The extension requests permission only for the chosen Grove origin. Tokens remain in local extension storage, never source-site storage.

Implemented: toolbar capture, active selection/highlight, article text, context menu, keyboard shortcut, tags, destination board, last-used destination, visible Instagram saved-post links. No account cookies/passwords are exported. No background crawling or automatic social publishing is performed. Source content must be accessible to the user.

Substack drafts use the web app's explicit browser handoff. Substack's native scheduler and confirmation remain the authority for delivery. Full automated local-session scheduling and daily Instagram collection synchronization remain tracked feature gaps; this capture extension does not claim them.
