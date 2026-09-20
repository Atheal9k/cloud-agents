// T3 Code's Electron host exports this to agents, but desktop test subprocesses
// must launch Electron normally unless a test opts into its Node mode explicitly.
delete process.env.ELECTRON_RUN_AS_NODE;
