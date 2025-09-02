print("Hello from test_interactive.py!")
print("This file has input() statements that will cause EOFError in terminal mode.")

# This will cause EOFError when run in terminal mode
try:
    user_input = input("Enter something: ")
    print(f"You entered: {user_input}")
except EOFError:
    print("EOFError: Interactive input not supported in terminal mode")
except Exception as e:
    print(f"Other error: {e}")

print("File execution completed!")
