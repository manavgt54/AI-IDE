```python
import os
from flask import Flask, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.exc import IntegrityError

# --- Flask App Initialization ---
app = Flask(__name__)

# --- Configuration ---
# Use an in-memory SQLite database for simplicity, or a file-based one
# For a file-based database, uncomment the line below and comment the in-memory one
# app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///tasks.db'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///:memory:' # In-memory for quick testing
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Initialize SQLAlchemy
db = SQLAlchemy(app)

# --- Task Model Definition ---
class Task(db.Model):
    """
    Represents a single task in the task management system.
    """
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(120), nullable=False)
    description = db.Column(db.String(500), nullable=True)
    done = db.Column(db.Boolean, default=False, nullable=False)

    def __repr__(self):
        """
        Returns a string representation of the Task object.
        """
        return f'<Task {self.id}: {self.title}>'

    def to_dict(self):
        """
        Converts the Task object into a dictionary suitable for JSON serialization.
        """
        return {
            'id': self.id,
            'title': self.title,
            'description': self.description,
            'done': self.done
        }

# --- Database Creation (within application context) ---
# This ensures tables are created when the app starts, if they don't exist.
with app.app_context():
    db.create_all()

# --- Error Handlers ---
@app.errorhandler(404)
def not_found_error(error):
    """
    Handles 404 Not Found errors, returning a JSON response.
    """
    return jsonify({'error': 'Not Found', 'message': 'The requested resource was not found.'}), 404

@app.errorhandler(400)
def bad_request_error(error):
    """
    Handles 400 Bad Request errors, returning a JSON response.
    """
    return jsonify({'error': 'Bad Request', 'message': error.description}), 400

@app.errorhandler(500)
def internal_server_error(error):
    """
    Handles 500 Internal Server Errors, returning a JSON response.
    """
    return jsonify({'error': 'Internal Server Error', 'message': 'An unexpected error occurred.'}), 500


# --- API Endpoints ---

@app.route('/tasks', methods=['GET'])
def get_tasks():
    """
    Retrieves all tasks from the database.
    ---
    Responses:
      200:
        description: A list of tasks.
        schema:
          type: object
          properties:
            tasks:
              type: array
              items:
                $ref: '#/definitions/Task'
    """
    tasks = Task.query.all()
    return jsonify({'tasks': [task.to_dict() for task in tasks]}), 200

@app.route('/tasks/<int:task_id>', methods=['GET'])
def get_task(task_id):
    """
    Retrieves a single task by its ID.
    ---
    Parameters:
      - in: path
        name: task_id
        type: integer
        required: true
        description: The ID of the task to retrieve.
    Responses:
      200:
        description: A single task object.
        schema:
          $ref: '#/definitions/Task'
      404:
        description: Task not found.
    """
    task = Task.query.get_or_404(task_id, description=f"Task with ID {task_id} not found.")
    return jsonify(task.to_dict()), 200

@app.route('/tasks', methods=['POST'])
def create_task():
    """
    Creates a new task.
    ---
    Parameters:
      - in: body
        name: task
        schema:
          type: object
          required:
            - title
          properties:
            title:
              type: string
              description: The title of the task.
            description:
              type: string
              description: An optional description for the task.
            done:
              type: boolean
              description: The completion status of the task (default: false).
    Responses:
      201:
        description: Task created successfully.
        schema:
          $ref: '#/definitions/Task'
      400:
        description: Bad request, e.g., missing title.
    """
    if not request.json or not 'title' in request.json:
        return jsonify({'error': 'Bad Request', 'message': 'Missing "title" in request body.'}), 400

    title = request.json['title']
    description = request.json.get('description', '')
    done = request.json.get('done', False)

    new_task = Task(title=title, description=description, done=done)

    try:
        db.session.add(new_task)
        db.session.commit()
        return jsonify(new_task.to_dict()), 201
    except IntegrityError:
        db.session.rollback()
        return jsonify({'error': 'Internal Server Error', 'message': 'Could not create task due to a database error.'}), 500
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), 500

@app.route('/tasks/<int:task_id>', methods=['PUT'])
def update_task(task_id):
    """
    Updates an existing task by its ID.
    ---
    Parameters:
      - in: path
        name: task_id
        type: integer
        required: true
        description: The ID of the task to update.
      - in: body
        name: task
        schema:
          type: object
          properties:
            title:
              type: string
              description: The new title of the task.
            description:
              type: string
              description: The new description for the task.
            done:
              type: boolean
              description: The new completion status of the task.
    Responses:
      200:
        description: Task updated successfully.
        schema:
          $ref: '#/definitions/Task'
      400:
        description: Bad request, e.g., invalid input data.
      404:
        description: Task not found.
    """
    task = Task.query.get_or_404(task_id, description=f"Task with ID {task_id} not found.")

    if not request.json:
        return jsonify({'error': 'Bad Request', 'message': 'Request body must be JSON.'}), 400

    # Update fields if present in the request JSON
    if 'title' in request.json:
        task.title = request.json['title']
    if 'description' in request.json:
        task.description = request.json['description']
    if 'done' in request.json:
        if isinstance(request.json['done'], bool):
            task.done = request.json['done']
        else:
            return jsonify({'error': 'Bad Request', 'message': '"done" field must be a boolean.'}), 400
    
    try:
        db.session.commit()
        return jsonify(task.to_dict()), 200
    except IntegrityError:
        db.session.rollback()
        return jsonify({'error': 'Internal Server Error', 'message': 'Could not update task due to a database error.'}), 500
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), 500

@app.route('/tasks/<int:task_id>', methods=['DELETE'])
def delete_task(task_id):
    """
    Deletes a task by its ID.
    ---
    Parameters:
      - in: path
        name: task_id
        type: integer
        required: true
        description: The ID of the task to delete.
    Responses:
      204:
        description: Task deleted successfully (No Content).
      404:
        description: Task not found.
    """
    task = Task.query.get_or_404(task_id, description=f"Task with ID {task_id} not found.")

    try:
        db.session.delete(task)
        db.session.commit()
        return '', 204 # No Content
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': 'Internal Server Error', 'message': str(e)}), 500

# --- Main entry point ---
if __name__ == '__main__':
    # Run the Flask app in debug mode.
    # In a production environment, you would use a WSGI server like Gunicorn or uWSGI.
    app.run(debug=True)
```