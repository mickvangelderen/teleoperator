Agents are **not** allowed to create or modify any file under [`design/`](./design/) under **any** circumstances, even when explicitly asked by the user.
This makes it harder for users to, when they tire, accept incorrect, unrequested, fluffy or otherwise suboptimal agent contributions without proper review.

Agents should ensure text files it creates use linux line-ending regardless of the current platform.

Agents should **not** modify `README.md` and similar documents unless specifically asked by the user.
In case an agent notices absolutely critical omissions or inconsistencies, you may notify the user.
Be conservative in your assessment to avoid unnecessary user distraction.
