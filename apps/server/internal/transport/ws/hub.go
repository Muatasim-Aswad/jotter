package wstransport

import (
	"sync"

	"github.com/Muatasim-Aswad/jotter/apps/server/internal/protocol"
	"github.com/coder/websocket"
)

const outboundQueueSize = 16

type session struct {
	id        string
	clientID  string
	sessionID string
	outgoing  chan []byte
	close     func(websocket.StatusCode, string) error
}

// Hub is delivery infrastructure only. It contains connections, never scratchpad state.
type Hub struct {
	mu       sync.Mutex
	sessions map[string]*session
	closed   bool
}

func NewHub() *Hub { return &Hub{sessions: make(map[string]*session)} }

func (hub *Hub) register(value *session) bool {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.closed {
		return false
	}
	hub.sessions[value.id] = value
	return true
}

func (hub *Hub) unregister(id string) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	value, ok := hub.sessions[id]
	if !ok {
		return
	}
	delete(hub.sessions, id)
	close(value.outgoing)
}

func (hub *Hub) send(id string, envelope protocol.Envelope) bool {
	data, err := protocol.Encode(envelope)
	if err != nil {
		return false
	}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	value, ok := hub.sessions[id]
	if !ok {
		return false
	}
	return hub.enqueueLocked(value, data)
}

// Publish broadcasts one committed update to every live connection.
func (hub *Hub) Publish(update *protocol.UpdateEnvelope) {
	hub.publishExcept(update, "")
}

func (hub *Hub) publishExcept(update *protocol.UpdateEnvelope, excludedID string) {
	data, err := protocol.Encode(update)
	if err != nil {
		return
	}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	for id, value := range hub.sessions {
		if id == excludedID {
			continue
		}
		hub.enqueueLocked(value, data)
	}
}

func (hub *Hub) enqueueLocked(value *session, data []byte) bool {
	select {
	case value.outgoing <- data:
		return true
	default:
		delete(hub.sessions, value.id)
		close(value.outgoing)
		go func() { _ = value.close(websocket.StatusPolicyViolation, "client is too slow") }()
		return false
	}
}

func (hub *Hub) Close(reason string) {
	hub.mu.Lock()
	if hub.closed {
		hub.mu.Unlock()
		return
	}
	hub.closed = true
	values := make([]*session, 0, len(hub.sessions))
	for id, value := range hub.sessions {
		delete(hub.sessions, id)
		close(value.outgoing)
		values = append(values, value)
	}
	hub.mu.Unlock()
	var wait sync.WaitGroup
	wait.Add(len(values))
	for _, value := range values {
		go func() {
			defer wait.Done()
			_ = value.close(websocket.StatusGoingAway, reason)
		}()
	}
	wait.Wait()
}

func (hub *Hub) sessionCount() int {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	return len(hub.sessions)
}
