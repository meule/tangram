


export default function mixin (target) {

    var events = new Map();

    return Object.assign(target, {

        on(event, listener) {
            // If passing a single argument, treat as key/value pairs of event/function
            if (arguments.length === 1 && typeof arguments[0] === 'object') {
                for (var e in arguments[0]) {
                    this.on(e, arguments[0][e]);
                }
                return;
            }

            // Otherwise, assume a single event and listener function was passed
            if (!events.get(event)) {
                events.set(event, new Set());
            }
            events.get(event).add(listener);
        },

        off(event, listener) {
            var set = events.get(event);
            if (set) {
                set.delete(listener);
            }
        },

        trigger(event, ...data) {
            var set = events.get(event);
            if (set) {
                set.forEach(listener => listener(...data));
            }
        }

    });

}



// export default function mixin (target) {

//     var listeners = new Set();

//     return Object.assign(target, {

//         on(listener) {
//             listeners.add(listener);
//         },

//         off(listener) {
//             listeners.delete(listener);
//         },

//         trigger(event, ...data) {
//             for (var listener of listeners) {
//                 if (typeof listener[event] === 'function') {
//                     listener[event](...data);
//                 }
//             }
//         }

//     });

// }
