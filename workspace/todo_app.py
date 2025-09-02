import os

def display_menu():
    """Displays the main menu options to the user."""
    print("\n--- To-Do App Menu ---")
    print("1. Add Task")
    print("2. View Tasks")
    print("3. Remove Task")
    print("4. Exit")
    print("----------------------")

def add_task(tasks, description):
    """Adds a new task to the list with a default 'completed' status of False.

    Args:
        tasks (list): The list of task dictionaries.
        description (str): The description of the task to add.
    """
    if description.strip(): # Ensure description is not just whitespace
        tasks.append({"description": description.strip(), "completed": False})
        print(f"Task '{description.strip()}' added successfully!")
    else:
        print("Error: Task description cannot be empty. Please try again.")

def view_tasks(tasks):
    """Displays all tasks in the list, showing their completion status.

    Args:
        tasks (list): The list of task dictionaries.
    """
    if not tasks:
        print("\nNo tasks in your list yet! Time to add some.")
        return

    print("\n--- Your To-Do List ---")
    for i, task in enumerate(tasks):
        status = "[X]" if task["completed"] else "[ ]" # [X] for completed, [ ] for not completed
        print(f"{i + 1}. {status} {task['description']}")
    print("-----------------------")

def remove_task(tasks, task_index):
    """Removes a task from the list based on its 1-based index.

    Args:
        tasks (list): The list of task dictionaries.
        task_index (int): The 1-based index of the task to remove.
    """
    try:
        # Adjust for 0-based indexing for list operations
        actual_index = task_index - 1
        if 0 <= actual_index < len(tasks):
            removed_task = tasks.pop(actual_index)
            print(f"Task '{removed_task['description']}' removed successfully!")
        else:
            print("Error: Invalid task number. Please enter a number from the list.")
    except TypeError: # Catches if task_index is not an integer
        print("Error: Invalid input. Please enter a whole number.")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

def run_todo_app():
    """Runs the main interactive To-Do application."""
    # Initialize an empty list to store tasks.
    # Each task is a dictionary: {"description": "Task description", "completed": False}
    tasks = [] 

    print("Welcome to your simple To-Do App!")

    while True:
        display_menu()
        choice = input("Enter your choice (1-4): ").strip()

        if choice == '1':
            description = input("Enter the task description: ")
            add_task(tasks, description)
        elif choice == '2':
            view_tasks(tasks)
        elif choice == '3':
            view_tasks(tasks) # Show tasks first so the user knows which number to remove
            if tasks: # Only ask to remove if there are tasks in the list
                try:
                    task_num_to_remove = int(input("Enter the number of the task to remove: "))
                    remove_task(tasks, task_num_to_remove)
                except ValueError:
                    print("Error: Invalid input. Please enter a valid number.")
            else:
                print("No tasks to remove. Please add some first.")
        elif choice == '4':
            print("Exiting To-Do App. Goodbye for now!")
            break # Exit the loop and terminate the application
        else:
            print("Error: Invalid choice. Please enter a number between 1 and 4.")
        
        # Optional: Clear screen for better readability in terminal apps
        # os.system('cls' if os.name == 'nt' else 'clear')

if __name__ == "__main__":
    run_todo_app()
