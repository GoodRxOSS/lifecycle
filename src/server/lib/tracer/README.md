# Tracer Util

The `Tracer` class is a util class with a few functions to make adding lifecycle tracing clean and clear.

---

## API

### `Tracer`

A class to manage lifecycle tracing.

### `getInstance()`

A singleton class accessing a Tracer instance.

### `initialize(name, tags)`

- `{name: string}`: The name of what's being traced
- `{tags: Object}`: Tags to add to the trace

### `wrap(name, fn, tags)`

- `{name: string}`: The name of what's being traced
- `{fn: Function}`: a function to wrap with tracing
- `{tags: Object}`: Tags to add to the trace

### `trace(name, fn, tags)`

- `{name: string}`: The name of what's being traced
- `{fn: Function}`: a function to wrap with tracing
- `{tags: Object}`: Tags to add to the trace

### `startSpan(name, tags)`

- `{name: string}`: The name of the span
- `{tags: Object}`: Tags to add to the span

### `Trace()`

A decorator class to manage tracing in classes.

Get more API details [here](https://datadoghq.dev/dd-trace-js/index.html).

---

## Recipes

As a decorator
```js
const tracer = Tracer.getInstance();
tracer.initialize('trace-name', {tag1: 'tag1', tag2: 'tag2'});

class MyClass {
  @Trace()
  myFunction() {
    // do something
  }
}
```

---

As a wrapper

> [!NOTE]
> Note the use of the arrow function here.

```js
const tracer = Tracer.getInstance();
tracer.initialize('trace-name', {tag1: 'tag1', tag2: 'tag2'});

class MyClass {
  myFunction = tracer.wrap(name, (data) {
    // do something
  }, {tag3: 'tag3', tag4: 'tag4'})
}
```

If you have issues with method arguments, you can try currying.

```js
const tracer = Tracer.getInstance();
tracer.initialize('trace-name', {tag1: 'tag1', tag2: 'tag2'});

class MyClass {
  myFunction = (data) => tracer.wrap(name, async () {
    // do something
  }, { tag1: 'tag1' })()
}
```

---

Within a function

```js
const tracer = Tracer.getInstance();
tracer.initialize('trace-name', {tag1: 'tag1', tag2: 'tag2'});

class MyClass {
  myFunction () {
    try {
      const span = tracer.startSpan('span-name');
      // and with tags
      const span2 = tracer.startSpan('span-name', {tag3: 'tag3', tag4: 'tag4'});
      // do something
    } catch (e) {

    } finally {
      span.finishSpan();
      span2.finishSpan();
    }
  }
}
```

---

Update tags at the instance level

```js
const tracer = Tracer.getInstance();
tracer.initialize('trace-name', {tag1: 'tag1', tag2: 'tag2'});

class MyClass {
  myFunction () {
    try {
      tracer.updateTags({tag3: 'tag3', tag4: 'tag4'});
      const span tracer.startSpan('span-name');
      // do something
    } catch (e) {

    } finally {
      span.finishSpan();
    }
  }
}

```

---

Add tags to span after creation

```js
const tracer = Tracer.getInstance();
tracer.initialize('trace-name', {tag1: 'tag1', tag2: 'tag2'});

class MyClass {
  myFunction () {
    try {
      const span = tracer.startSpan('span-name');
      // do something
      span.addTags({tag3: 'tag3', tag4: 'tag4'});
    } catch (e) {

    } finally {
      span.finishSpan();
    }
  }
}
```

---

[Back to root](../../../../readme.md)
