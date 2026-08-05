# Use unified outbound host connections

Every Computer will use the same Buzzcode Host protocol for Agent and file operations. The desktop app runs the Host on a user's computer, and a headless Host runs on a VPS; both establish an authenticated outbound connection and execute locally, while the central service neither initiates SSH sessions nor retains Host SSH private keys. This avoids separate local and remote integration stacks and supports Computers behind NAT, at the cost of operating a Host process everywhere Agents run.
