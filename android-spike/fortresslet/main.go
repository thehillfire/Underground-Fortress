// fortresslet: the stand-in for the fortress server in the spike. A small static program that the app
// starts from its foreground service. It answers on 127.0.0.1:4330 and logs a heartbeat, so the app can
// check it is alive. Built for linux/arm64 with CGO off, so it needs nothing from the phone's libc.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"
)

func main() {
	started := time.Now()
	pid := os.Getpid()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"pid":        pid,
			"uptimeSec":  int(time.Since(started).Seconds()),
			"started":    started.Format(time.RFC3339),
		})
	})
	ln, err := net.Listen("tcp", "127.0.0.1:4330")
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen:", err)
		os.Exit(2)
	}
	log.Printf("fortresslet up pid=%d on 127.0.0.1:4330", pid)
	go func() {
		t := time.NewTicker(60 * time.Second)
		for range t.C {
			log.Printf("heartbeat pid=%d uptime=%s", pid, time.Since(started).Round(time.Second))
		}
	}()
	log.Fatal(http.Serve(ln, mux))
}
