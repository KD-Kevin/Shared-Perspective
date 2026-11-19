import { listenLocalSession } from "./LocalSessionIpc";

void listenLocalSession().catch(error => {
    // Simultaneous app launches may both try to start the same per-user pipe.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return;
    console.error(error);
    process.exitCode = 1;
});
